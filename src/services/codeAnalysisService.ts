import * as vscode from 'vscode';
import * as ts from 'typescript';
import { LanguageRegistry } from '../languages/registry';
import * as path from 'path';
import { FileSystemService } from './fileSystemService';

export interface DependencyNode {
    filePath: string;
    imports: string[];
    importedBy: string[];
    weight: number;  // Number of files that depend on this
}

export interface CodeLocation {
    filePath: string;
    symbol: string;
    type: 'definition' | 'reference' | 'implementation';
    range: {
        startLine: number;
        endLine: number;
        startColumn: number;
        endColumn: number;
    };
}

export interface CodeDiff {
    type: 'addition' | 'deletion' | 'modification';
    startLine: number;
    endLine: number;
    oldContent?: string;
    newContent?: string;
    reasoning?: string;
}

export interface CodeProposal {
    filePath: string;
    diffs: CodeDiff[];
    requiresApproval: boolean;
    impact: {
        dependencies: string[];
        potentialIssues: string[];
    };
}

export interface TypeCheckResult {
    isValid: boolean;
    errors: Array<{
        message: string;
        location: CodeLocation;
        relatedLocations: CodeLocation[];
    }>;
}

export interface SymbolReference {
    symbol: string;
    location: CodeLocation;
    type: 'declaration' | 'definition' | 'reference' | 'import' | 'reexport';
    metadata?: {
        isDynamic?: boolean;
        isIndirect?: boolean;
        throughSymbol?: string;
    };
}

export interface CallHierarchyItem {
    symbol: string;
    location: CodeLocation;
    callers: Array<{
        symbol: string;
        location: CodeLocation;
        argumentTypes?: string[];
    }>;
    callees: Array<{
        symbol: string;
        location: CodeLocation;
        argumentTypes?: string[];
    }>;
}

export interface TypeHierarchyItem {
    symbol: string;
    location: CodeLocation;
    kind: 'class' | 'interface' | 'type';
    superTypes: Array<{
        symbol: string;
        location: CodeLocation;
    }>;
    subTypes: Array<{
        symbol: string;
        location: CodeLocation;
    }>;
    implementations?: Array<{
        symbol: string;
        location: CodeLocation;
    }>;
}

export class CodeAnalysisService {
    private dependencyGraph: Map<string, DependencyNode>;
    private program: ts.Program | undefined;
    private typeChecker: ts.TypeChecker | undefined;
    private fileSystemService: FileSystemService;
    private outputChannel: vscode.OutputChannel;
    private pendingProposals: Map<string, CodeProposal>;
    private languageRegistry: LanguageRegistry;
    private symbolCache: Map<string, SymbolReference[]> = new Map();
    private callHierarchyCache: Map<string, CallHierarchyItem> = new Map();
    private typeHierarchyCache: Map<string, TypeHierarchyItem> = new Map();

    constructor(fileSystemService: FileSystemService) {
        this.dependencyGraph = new Map();
        this.program = undefined;
        this.fileSystemService = fileSystemService;
        this.outputChannel = vscode.window.createOutputChannel('Code Analysis');
        this.pendingProposals = new Map();
        this.languageRegistry = LanguageRegistry.getInstance();
    }

    // Initialize TypeScript program for type checking
    async initializeTypeScript(workspacePath: string): Promise<void> {
        try {
            const configPath = ts.findConfigFile(
                workspacePath,
                ts.sys.fileExists,
                'tsconfig.json'
            );

            if (!configPath) {
                throw new Error('Could not find tsconfig.json');
            }

            const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
            const parsedConfig = ts.parseJsonConfigFileContent(
                configFile.config,
                ts.sys,
                path.dirname(configPath)
            );

            this.program = ts.createProgram(
                parsedConfig.fileNames,
                parsedConfig.options
            );
            this.typeChecker = this.program.getTypeChecker();
        } catch (error) {
            this.logError('Error initializing TypeScript:', error);
        }
    }

    async proposeChanges(filePath: string, changes: CodeDiff[]): Promise<CodeProposal> {
        const proposal: CodeProposal = {
            filePath,
            diffs: changes,
            requiresApproval: true,
            impact: await this.analyzeChangeImpact(filePath, changes)
        };

        this.pendingProposals.set(filePath, proposal);
        await this.showDiffPreview(proposal);
        return proposal;
    }

    private async analyzeChangeImpact(filePath: string, changes: CodeDiff[]): Promise<CodeProposal['impact']> {
        const impactedFiles = this.getImpactedFiles(filePath);
        const potentialIssues: string[] = [];

        // Analyze each change for potential issues
        for (const change of changes) {
            if (change.type === 'deletion') {
                const references = await this.findSymbolLocations(change.oldContent || '', true);
                if (references.length > 0) {
                    potentialIssues.push(`Deletion affects ${references.length} references in other files`);
                }
            }

            if (change.type === 'modification') {
                const oldSymbols = this.extractSymbols(change.oldContent || '');
                const newSymbols = this.extractSymbols(change.newContent || '');
                const removedSymbols = oldSymbols.filter(s => !newSymbols.includes(s));
                
                if (removedSymbols.length > 0) {
                    potentialIssues.push(`Modification removes symbols: ${removedSymbols.join(', ')}`);
                }
            }
        }

        return {
            dependencies: impactedFiles,
            potentialIssues
        };
    }

    private async showDiffPreview(proposal: CodeProposal): Promise<void> {
        const uri = vscode.Uri.file(proposal.filePath);
        const document = await vscode.workspace.openTextDocument(uri);
        const originalContent = document.getText();

        // Create diff content
        let diffContent = '';
        let currentLine = 0;

        for (const diff of proposal.diffs) {
            // Add unchanged content before the diff
            if (diff.startLine > currentLine) {
                diffContent += originalContent.split('\n')
                    .slice(currentLine, diff.startLine)
                    .join('\n') + '\n';
            }

            // Add the diff with highlighting
            switch (diff.type) {
                case 'addition':
                    diffContent += `+ ${diff.newContent}\n`;
                    break;
                case 'deletion':
                    diffContent += `- ${diff.oldContent}\n`;
                    break;
                case 'modification':
                    diffContent += `- ${diff.oldContent}\n`;
                    diffContent += `+ ${diff.newContent}\n`;
                    break;
            }

            currentLine = diff.endLine + 1;
        }

        // Show diff in a new editor
        const diffDocument = await vscode.workspace.openTextDocument({
            content: diffContent,
            language: 'diff'
        });
        await vscode.window.showTextDocument(diffDocument, { preview: true });
    }

    // Build dependency graph for the workspace
    async buildDependencyGraph(workspacePath: string): Promise<void> {
        try {
            const files = await this.fileSystemService.getAllFilesInWorkspace(workspacePath);

            // Initialize nodes
            for (const file of files) {
                const fileContent = await this.fileSystemService.readFile(file);
                const handler = this.languageRegistry.getHandlerForFile(file);
                
                const node: DependencyNode = {
                    filePath: file,
                    imports: handler ? await handler.analyzeImports(fileContent) : [],
                    importedBy: [],
                    weight: 0
                };

                this.dependencyGraph.set(file, node);
            }

            // Build importedBy relationships and calculate weights
            for (const [file, node] of this.dependencyGraph) {
                for (const imp of node.imports) {
                    const resolvedPath = this.resolveImportPath(file, imp);
                    if (resolvedPath) {
                        const importedNode = this.dependencyGraph.get(resolvedPath);
                        if (importedNode) {
                            importedNode.importedBy.push(file);
                            importedNode.weight++;
                        }
                    }
                }
            }
        } catch (error) {
            this.logError('Error building dependency graph:', error);
        }
    }

    // Find all locations of a symbol across the workspace
    async findSymbolLocations(symbolOrContent: string, isContent: boolean = false): Promise<CodeLocation[]> {
        const locations: CodeLocation[] = [];

        // For TypeScript/JavaScript files, use TypeScript Compiler API
        if (this.program && this.typeChecker) {
            locations.push(...await this.findTypeScriptSymbolLocations(symbolOrContent, isContent));
        }

        // For other languages, use their respective handlers
        const handlers = new Set(this.languageRegistry.getSupportedExtensions().map(ext => 
            this.languageRegistry.getHandlerForFile(`.${ext}`)
        ));

        for (const handler of handlers) {
            if (!handler) continue;

            try {
                const structure = await handler.analyzeStructure(isContent ? symbolOrContent : '');
                const symbols = isContent ? 
                    structure.map(item => item.name) :
                    [symbolOrContent];

                for (const symbol of symbols) {
                    // Search through all workspace files with matching extension
                    const files = await vscode.workspace.findFiles(`**/*${handler.fileExtensions[0]}`);
                    for (const file of files) {
                        const document = await vscode.workspace.openTextDocument(file);
                        const fileStructure = await handler.analyzeStructure(document.getText());
                        
                        for (const item of fileStructure) {
                            if (item.name === symbol) {
                                locations.push({
                                    filePath: file.fsPath,
                                    symbol,
                                    type: 'reference' as const,
                                    range: {
                                        startLine: item.startLine,
                                        endLine: item.endLine,
                                        startColumn: 0,  // Handler doesn't provide column info
                                        endColumn: document.lineAt(item.endLine).text.length
                                    }
                                });
                            }
                        }
                    }
                }
            } catch (error) {
                this.outputChannel.appendLine(`Error analyzing symbols with ${handler.languageId} handler: ${error}`);
            }
        }

        return locations;
    }

    private async findTypeScriptSymbolLocations(symbolOrContent: string, isContent: boolean): Promise<CodeLocation[]> {
        if (!this.program || !this.typeChecker) {
            return [];
        }

        const locations: CodeLocation[] = [];

        if (isContent) {
            const tempFile = ts.createSourceFile(
                'temp.ts',
                symbolOrContent,
                ts.ScriptTarget.Latest,
                true
            );

            const symbols = new Set<string>();
            ts.forEachChild(tempFile, (node) => {
                if (ts.isIdentifier(node)) {
                    symbols.add(node.text);
                }
            });

            for (const symbol of symbols) {
                locations.push(...await this.findTypeScriptSymbolLocations(symbol, false));
            }
        } else {
            for (const sourceFile of this.program.getSourceFiles()) {
                if (sourceFile.isDeclarationFile) continue;

                ts.forEachChild(sourceFile, (node) => {
                    if (ts.isIdentifier(node) && node.text === symbolOrContent) {
                        const definition = this.typeChecker!.getSymbolAtLocation(node);
                        if (definition) {
                            const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
                            const endPos = sourceFile.getLineAndCharacterOfPosition(node.getEnd());

                            locations.push({
                                filePath: sourceFile.fileName,
                                symbol: symbolOrContent,
                                type: 'reference' as const,
                                range: {
                                    startLine: line,
                                    endLine: endPos.line,
                                    startColumn: character,
                                    endColumn: endPos.character
                                }
                            });
                        }
                    }
                });
            }
        }

        return locations;
    }

    public extractSymbols(content: string): string[] {
        const sourceFile = ts.createSourceFile(
            'temp.ts',
            content,
            ts.ScriptTarget.Latest,
            true
        );

        const symbols: string[] = [];
        function visit(node: ts.Node) {
            if (ts.isIdentifier(node)) {
                symbols.push(node.text);
            }
            ts.forEachChild(node, visit);
        }
        visit(sourceFile);
        return [...new Set(symbols)];
    }

    // Enhanced symbol finding with support for dynamic imports and indirect references
    async findSymbolReferences(symbol: string): Promise<SymbolReference[]> {
        // Check cache first
        if (this.symbolCache.has(symbol)) {
            return this.symbolCache.get(symbol)!;
        }

        const references: SymbolReference[] = [];
        
        if (!this.program || !this.typeChecker) {
            return references;
        }

        for (const sourceFile of this.program.getSourceFiles()) {
            if (sourceFile.isDeclarationFile) continue;

            const visit = (node: ts.Node) => {
                // Handle direct references
                if (ts.isIdentifier(node) && node.text === symbol) {
                    const symbolInfo = this.typeChecker!.getSymbolAtLocation(node);
                    if (symbolInfo) {
                        references.push(this.createSymbolReference(node, symbolInfo, 'reference'));
                    }
                }
                
                // Handle dynamic imports
                if (ts.isCallExpression(node) && 
                ts.isIdentifier(node.expression) && 
                node.expression.text === 'import') {
                const [argument] = node.arguments;
                if (ts.isStringLiteral(argument)) {
                    const importPath = argument.text;
                    if (importPath.includes(symbol)) {
                        references.push(this.createSymbolReference(node, undefined, 'import', {
                            isDynamic: true
                        }));
                    }
                }
                }
                
                // Handle indirect references through variables
                if (ts.isVariableDeclaration(node)) {
                    const type = this.typeChecker!.getTypeAtLocation(node);
                    const properties = type.getProperties();
                    for (const prop of properties) {
                        if (prop.name === symbol) {
                            references.push(this.createSymbolReference(node, prop, 'reference', {
                                isIndirect: true,
                                throughSymbol: node.name.getText()
                            }));
                        }
                    }
                }

                ts.forEachChild(node, visit);
            };

            visit(sourceFile);
        }

        // Cache the results
        this.symbolCache.set(symbol, references);
        return references;
    }

    // Build call hierarchy for a given function
    async buildCallHierarchy(functionSymbol: string): Promise<CallHierarchyItem | undefined> {
        if (this.callHierarchyCache.has(functionSymbol)) {
            return this.callHierarchyCache.get(functionSymbol);
        }

        if (!this.program || !this.typeChecker) {
            return undefined;
        }

        const callers: CallHierarchyItem['callers'] = [];
        const callees: CallHierarchyItem['callees'] = [];
        let symbolLocation: CodeLocation | undefined;

        for (const sourceFile of this.program.getSourceFiles()) {
            if (sourceFile.isDeclarationFile) continue;

            const visit = (node: ts.Node) => {
                // Find function definition
                if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
                    const name = node.name?.getText();
                    if (name === functionSymbol) {
                        symbolLocation = this.createCodeLocation(node);
                        
                        // Find callees within the function
                        ts.forEachChild(node, calleeNode => {
                            if (ts.isCallExpression(calleeNode)) {
                                const calleeName = calleeNode.expression.getText();
                                const argumentTypes = calleeNode.arguments.map(arg => 
                                    this.typeChecker!.getTypeAtLocation(arg).toString()
                                );
                                
                                callees.push({
                                    symbol: calleeName,
                                    location: this.createCodeLocation(calleeNode),
                                    argumentTypes
                                });
                            }
                        });
                    }
                }

                // Find callers of the function
                if (ts.isCallExpression(node)) {
                    const calledFunction = node.expression.getText();
                    if (calledFunction === functionSymbol) {
                        let enclosingFunction = this.findEnclosingFunction(node);
                        if (enclosingFunction) {
                            const argumentTypes = node.arguments.map(arg => 
                                this.typeChecker!.getTypeAtLocation(arg).toString()
                            );
                            
                            callers.push({
                                symbol: enclosingFunction.name?.getText() || 'anonymous',
                                location: this.createCodeLocation(enclosingFunction),
                                argumentTypes
                            });
                        }
                    }
                }

                ts.forEachChild(node, visit);
            };

            visit(sourceFile);
        }

        if (!symbolLocation) {
            return undefined;
        }

        const hierarchy: CallHierarchyItem = {
            symbol: functionSymbol,
            location: symbolLocation,
            callers,
            callees
        };

        this.callHierarchyCache.set(functionSymbol, hierarchy);
        return hierarchy;
    }

    // Build type hierarchy for a given class or interface
    async buildTypeHierarchy(typeSymbol: string): Promise<TypeHierarchyItem | undefined> {
        if (this.typeHierarchyCache.has(typeSymbol)) {
            return this.typeHierarchyCache.get(typeSymbol);
        }

        if (!this.program || !this.typeChecker) {
            return undefined;
        }

        let symbolLocation: CodeLocation | undefined;
        const superTypes: TypeHierarchyItem['superTypes'] = [];
        const subTypes: TypeHierarchyItem['subTypes'] = [];
        const implementations: TypeHierarchyItem['implementations'] = [];
        let kind: TypeHierarchyItem['kind'] = 'class';

        for (const sourceFile of this.program.getSourceFiles()) {
            if (sourceFile.isDeclarationFile) continue;

            const visit = (node: ts.Node) => {
                if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
                    const name = node.name?.getText();
                    
                    if (name === typeSymbol) {
                        symbolLocation = this.createCodeLocation(node);
                        kind = ts.isClassDeclaration(node) ? 'class' : 'interface';

                        // Find super types
                        if (node.heritageClauses) {
                            for (const clause of node.heritageClauses) {
                                for (const type of clause.types) {
                                    superTypes.push({
                                        symbol: type.expression.getText(),
                                        location: this.createCodeLocation(type)
                                    });
                                }
                            }
                        }
                    } else {
                        // Check if this type extends or implements our target type
                        if (node.heritageClauses) {
                            for (const clause of node.heritageClauses) {
                                for (const type of clause.types) {
                                    if (type.expression.getText() === typeSymbol) {
                                        const item = {
                                            symbol: name!,
                                            location: this.createCodeLocation(node)
                                        };
                                        
                                        if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
                                            subTypes.push(item);
                                        } else if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
                                            implementations?.push(item);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                ts.forEachChild(node, visit);
            };

            visit(sourceFile);
        }

        if (!symbolLocation) {
            return undefined;
        }

        const hierarchy: TypeHierarchyItem = {
            symbol: typeSymbol,
            location: symbolLocation,
            kind,
            superTypes,
            subTypes,
            implementations
        };

        this.typeHierarchyCache.set(typeSymbol, hierarchy);
        return hierarchy;
    }

    private createSymbolReference(
        node: ts.Node, 
        symbol?: ts.Symbol, 
        type: SymbolReference['type'] = 'reference',
        metadata?: SymbolReference['metadata']
    ): SymbolReference {
        const sourceFile = node.getSourceFile();
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        const endPos = sourceFile.getLineAndCharacterOfPosition(node.getEnd());

        return {
            symbol: symbol?.name || node.getText(),
            location: {
                filePath: sourceFile.fileName,
                symbol: symbol?.name || node.getText(),
                type: 'reference',
                range: {
                    startLine: line,
                    endLine: endPos.line,
                    startColumn: character,
                    endColumn: endPos.character
                }
            },
            type,
            metadata
        };
    }

    private createCodeLocation(node: ts.Node): CodeLocation {
        const sourceFile = node.getSourceFile();
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        const endPos = sourceFile.getLineAndCharacterOfPosition(node.getEnd());

        return {
            filePath: sourceFile.fileName,
            symbol: node.getText(),
            type: 'definition',
            range: {
                startLine: line,
                endLine: endPos.line,
                startColumn: character,
                endColumn: endPos.character
            }
        };
    }

    private findEnclosingFunction(node: ts.Node): ts.FunctionDeclaration | ts.MethodDeclaration | undefined {
        let current = node.parent;
        while (current) {
            if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) {
                return current;
            }
            current = current.parent;
        }
        return undefined;
    }

    // Clear caches when files change
    clearCaches(): void {
        this.symbolCache.clear();
        this.callHierarchyCache.clear();
        this.typeHierarchyCache.clear();
    }

    async acceptProposal(filePath: string, acceptedDiffs?: number[]): Promise<void> {
        const proposal = this.pendingProposals.get(filePath);
        if (!proposal) {
            throw new Error('No pending proposal found for this file');
        }

        const diffsToApply = acceptedDiffs 
            ? proposal.diffs.filter((_, index) => acceptedDiffs.includes(index))
            : proposal.diffs;

        // Apply the accepted changes
        const uri = vscode.Uri.file(filePath);
        const document = await vscode.workspace.openTextDocument(uri);
        const edit = new vscode.WorkspaceEdit();

        for (const diff of diffsToApply) {
            const range = new vscode.Range(
                diff.startLine, 0,
                diff.endLine, document.lineAt(diff.endLine).text.length
            );

            if (diff.type === 'deletion') {
                edit.delete(uri, range);
            } else {
                edit.replace(uri, range, diff.newContent || '');
            }
        }

        await vscode.workspace.applyEdit(edit);
        this.pendingProposals.delete(filePath);
    }

    async rejectProposal(filePath: string, reason?: string): Promise<void> {
        const proposal = this.pendingProposals.get(filePath);
        if (!proposal) {
            throw new Error('No pending proposal found for this file');
        }

        if (reason) {
            this.outputChannel.appendLine(`Proposal rejected for ${filePath}: ${reason}`);
        }

        this.pendingProposals.delete(filePath);
    }

    // Check types in a specific file
    async checkTypes(filePath: string): Promise<TypeCheckResult> {
        if (!this.program || !this.typeChecker) {
            return { isValid: false, errors: [] };
        }

        const sourceFile = this.program.getSourceFile(filePath);
        if (!sourceFile) {
            return { isValid: false, errors: [] };
        }

        const diagnostics = [
            ...this.program.getSemanticDiagnostics(sourceFile),
            ...this.program.getSyntacticDiagnostics(sourceFile)
        ];

        const errors = diagnostics.map(diagnostic => {
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(diagnostic.start!);
            const endPos = sourceFile.getLineAndCharacterOfPosition(diagnostic.start! + diagnostic.length!);

            const location: CodeLocation = {
                filePath,
                symbol: '',
                type: 'reference' as const,  // Type assertion to fix the type error
                range: {
                    startLine: line,
                    endLine: endPos.line,
                    startColumn: character,
                    endColumn: endPos.character
                }
            };

            return {
                message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
                location,
                relatedLocations: [] as CodeLocation[]  // Type assertion to fix array type
            };
        });

        return {
            isValid: errors.length === 0,
            errors
        };
    }

    // Get files that would be impacted by changes to a file
    getImpactedFiles(filePath: string): string[] {
        const node = this.dependencyGraph.get(filePath);
        if (!node) return [];

        const impacted = new Set<string>();
        const queue = [filePath];

        while (queue.length > 0) {
            const current = queue.shift()!;
            const currentNode = this.dependencyGraph.get(current);
            if (!currentNode) continue;

            for (const importedBy of currentNode.importedBy) {
                if (!impacted.has(importedBy)) {
                    impacted.add(importedBy);
                    queue.push(importedBy);
                }
            }
        }

        return Array.from(impacted);
    }

    private resolveImportPath(fromFile: string, importPath: string): string | undefined {
        try {
            if (importPath.startsWith('.')) {
                return path.resolve(path.dirname(fromFile), importPath);
            }
            return undefined; // Skip node_modules imports
        } catch (error) {
            this.logError('Error resolving import path:', error);
            return undefined;
        }
    }

    private logError(message: string, error: unknown): void {
        this.outputChannel.appendLine(`${message} ${error}`);
    }
}