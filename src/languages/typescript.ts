import * as vscode from 'vscode';
import { BaseLanguageHandler } from './base';
import * as ts from 'typescript';

export class TypeScriptHandler extends BaseLanguageHandler {
    readonly fileExtensions = ['.ts', '.tsx'];
    readonly languageId = 'typescript';
    readonly importPatterns = [
        /import\s+(?:(?:\*\s+as\s+\w+)|(?:{\s*[\w\s,]+\s*})|(?:[\w]+))?\s*from\s*['"]([^'"]+)['"]/g,
        /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
        /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    ];
    readonly dependencyPatterns = [
        /package\.json/g,
        /tsconfig\.json/g
    ];
    readonly functionPatterns = [
        /(?:async\s+)?function\s+(\w+)/g,
        /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/g,
        /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/g
    ];
    readonly classPatterns = [
        /class\s+(\w+)/g,
        /interface\s+(\w+)/g
    ];
    readonly blockPatterns = [
        /\{[^{}]*\}/g
    ];

    validateSyntax(content: string): boolean {
        try {
            ts.createSourceFile(
                'temp.ts',
                content,
                ts.ScriptTarget.Latest,
                true
            );
            return true;
        } catch {
            return false;
        }
    }

    validateImports(content: string): boolean {
        // Check if all imports are properly formatted
        const importLines = content.match(/^import.*$/gm);
        if (!importLines) return true;

        return importLines.every(line => {
            try {
                ts.createSourceFile(
                    'temp.ts',
                    line,
                    ts.ScriptTarget.Latest,
                    true
                );
                return true;
            } catch {
                return false;
            }
        });
    }

    validateStructure(content: string): boolean {
        try {
            const sourceFile = ts.createSourceFile(
                'temp.ts',
                content,
                ts.ScriptTarget.Latest,
                true
            );
            
            // Check for basic structural validity
            let hasErrors = false;
            ts.forEachChild(sourceFile, node => {
                if (ts.isClassDeclaration(node) && !node.name) {
                    hasErrors = true;
                }
                if (ts.isFunctionDeclaration(node) && !node.name) {
                    hasErrors = true;
                }
            });
            
            return !hasErrors;
        } catch {
            return false;
        }
    }

    formatCode(content: string): string {
        try {
            const fileName = 'temp.ts';
            const sourceFile = ts.createSourceFile(
                fileName,
                content,
                ts.ScriptTarget.Latest,
                true
            );

            const languageService = ts.createLanguageService({
                getCompilationSettings: () => ({
                    target: ts.ScriptTarget.Latest,
                    module: ts.ModuleKind.ESNext,
                    strict: true,
                    esModuleInterop: true,
                    skipLibCheck: true,
                    forceConsistentCasingInFileNames: true
                }),
                getScriptFileNames: () => [fileName],
                getScriptVersion: () => '0',
                getScriptSnapshot: (name) => {
                    if (name === fileName) {
                        return ts.ScriptSnapshot.fromString(content);
                    }
                    return undefined;
                },
                getCurrentDirectory: () => '/',
                getDefaultLibFileName: () => 'lib.d.ts',
                fileExists: () => true,
                readFile: () => '',
                readDirectory: () => [],
                directoryExists: () => true,
                getDirectories: () => []
            });

            const edits = languageService.getFormattingEditsForDocument(
                fileName,
                {
                    indentSize: 4,
                    tabSize: 4,
                    newLineCharacter: '\n',
                    convertTabsToSpaces: true,
                    insertSpaceAfterCommaDelimiter: true,
                    insertSpaceAfterSemicolonInForStatements: true,
                    insertSpaceBeforeAndAfterBinaryOperators: true,
                    insertSpaceAfterKeywordsInControlFlowStatements: true,
                    insertSpaceAfterFunctionKeywordForAnonymousFunctions: true,
                    insertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis: false,
                    insertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets: false,
                    insertSpaceAfterOpeningAndBeforeClosingTemplateStringBraces: false,
                    placeOpenBraceOnNewLineForFunctions: false,
                    placeOpenBraceOnNewLineForControlBlocks: false
                }
            );

            let result = content;
            for (const edit of edits.reverse()) {
                const head = result.slice(0, edit.span.start);
                const tail = result.slice(edit.span.start + edit.span.length);
                result = head + edit.newText + tail;
            }
            return result;
        } catch {
            return content;
        }
    }

    injectImports(content: string, imports: string[]): string {
        // Add new imports at the top of the file
        const newImports = imports
            .map(imp => `import '${imp}';`)
            .join('\n');
        
        // Find the last import statement
        const lastImportIndex = content.search(/^(?!import).*$/m);
        
        if (lastImportIndex === -1) {
            return `${newImports}\n\n${content}`;
        }
        
        return content.slice(0, lastImportIndex) + 
               newImports + '\n' + 
               content.slice(lastImportIndex);
    }

    wrapInFunction(content: string, functionName: string): string {
        return `function ${functionName}() {\n${content}\n}`;
    }

    async getFileStructure(document: vscode.TextDocument): Promise<Array<{
        type: string;
        name: string;
        range: {
            start: { line: number };
            end: { line: number };
        };
    }>> {
        const content = document.getText();
        const sourceFile = ts.createSourceFile(
            document.fileName,
            content,
            ts.ScriptTarget.Latest,
            true
        );

        const structure: Array<{
            type: string;
            name: string;
            range: {
                start: { line: number };
                end: { line: number };
            };
        }> = [];

        function visit(node: ts.Node) {
            if (ts.isClassDeclaration(node) && node.name) {
                structure.push({
                    type: 'class',
                    name: node.name.text,
                    range: {
                        start: { line: sourceFile.getLineAndCharacterOfPosition(node.pos).line },
                        end: { line: sourceFile.getLineAndCharacterOfPosition(node.end).line }
                    }
                });
            } else if (ts.isFunctionDeclaration(node) && node.name) {
                structure.push({
                    type: 'function',
                    name: node.name.text,
                    range: {
                        start: { line: sourceFile.getLineAndCharacterOfPosition(node.pos).line },
                        end: { line: sourceFile.getLineAndCharacterOfPosition(node.end).line }
                    }
                });
            } else if (ts.isInterfaceDeclaration(node)) {
                structure.push({
                    type: 'interface',
                    name: node.name.text,
                    range: {
                        start: { line: sourceFile.getLineAndCharacterOfPosition(node.pos).line },
                        end: { line: sourceFile.getLineAndCharacterOfPosition(node.end).line }
                    }
                });
            }

            ts.forEachChild(node, visit);
        }

        visit(sourceFile);
        return structure;
    }

    parseImport(match: RegExpMatchArray): string {
        return match[1];
    }

    parseFunction(match: RegExpMatchArray): { name: string; params: string[]; returnType?: string; } {
        const [_, name, params = '', returnType = ''] = match;
        return {
            name,
            params: params.split(',').map(p => p.trim()).filter(Boolean),
            returnType: returnType.trim() || undefined
        };
    }

    analyzeDependencies(content: string): string[] {
        const sourceFile = ts.createSourceFile(
            'temp.ts',
            content,
            ts.ScriptTarget.Latest,
            true
        );

        const dependencies: Set<string> = new Set();

        const visit = (node: ts.Node) => {
            if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
                const moduleSpecifier = node.moduleSpecifier;
                if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier)) {
                    dependencies.add(moduleSpecifier.text);
                }
            }
            ts.forEachChild(node, visit);
        };

        visit(sourceFile);
        return Array.from(dependencies);
    }

    analyzeFunctions(content: string): { name: string; params: string[]; returnType?: string; complexity: number; }[] {
        const sourceFile = ts.createSourceFile(
            'temp.ts',
            content,
            ts.ScriptTarget.Latest,
            true
        );

        const functions: { name: string; params: string[]; returnType?: string; complexity: number; }[] = [];

        const visit = (node: ts.Node) => {
            if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
                const name = node.name?.getText(sourceFile) || 'anonymous';
                const params = node.parameters.map(p => p.getText(sourceFile));
                const returnType = node.type?.getText(sourceFile);
                const complexity = this.calculateComplexity(node);

                functions.push({ name, params, returnType, complexity });
            }
            ts.forEachChild(node, visit);
        };

        visit(sourceFile);
        return functions;
    }

    private calculateComplexity(node: ts.Node): number {
        let complexity = 1;

        const visit = (node: ts.Node) => {
            if (ts.isIfStatement(node) || 
                ts.isForStatement(node) || 
                ts.isWhileStatement(node) || 
                ts.isDoStatement(node) ||
                ts.isCaseClause(node) ||
                ts.isConditionalExpression(node)) {
                complexity++;
            }
            ts.forEachChild(node, visit);
        };

        visit(node);
        return complexity;
    }

    analyzeImports(content: string): string[] {
        const sourceFile = ts.createSourceFile(
            'temp.ts',
            content,
            ts.ScriptTarget.Latest,
            true
        );

        const imports: string[] = [];

        const visit = (node: ts.Node) => {
            if (ts.isImportDeclaration(node)) {
                const moduleSpecifier = node.moduleSpecifier;
                if (ts.isStringLiteral(moduleSpecifier)) {
                    imports.push(moduleSpecifier.text);
                }
            }
            ts.forEachChild(node, visit);
        };

        visit(sourceFile);
        return imports;
    }

    generateImports(dependencies: string[]): string {
        return dependencies
            .map(dep => `import * as ${this.generateImportName(dep)} from '${dep}';`)
            .join('\n');
    }

    private generateImportName(dependency: string): string {
        return dependency
            .split('/')
            .pop()!
            .replace(/[^a-zA-Z0-9]/g, '')
            .replace(/^(\d)/, '_$1');
    }

    generateFunction(name: string, params: string[], returnType: string, body: string): string {
        const paramsList = params.map(p => `${p}: any`).join(', ');
        return `function ${name}(${paramsList})${returnType ? `: ${returnType}` : ''} {\n${body}\n}`;
    }

    generateClass(name: string, properties: string[], methods: string[]): string {
        const props = properties.map(p => `    ${p}: any;`).join('\n');
        const meths = methods.map(m => `    ${m}`).join('\n\n');
        return `class ${name} {\n${props}\n\n${meths}\n}`;
    }

    analyzeStructure(content: string): { type: 'function' | 'class' | 'interface' | 'variable' | 'other'; name: string; startLine: number; endLine: number; }[] {
        const sourceFile = ts.createSourceFile(
            'temp.ts',
            content,
            ts.ScriptTarget.Latest,
            true
        );

        const structure: { type: 'function' | 'class' | 'interface' | 'variable' | 'other'; name: string; startLine: number; endLine: number; }[] = [];

        const visit = (node: ts.Node) => {
            let type: 'function' | 'class' | 'interface' | 'variable' | 'other' = 'other';
            let name = '';

            if (ts.isFunctionDeclaration(node) && node.name) {
                type = 'function';
                name = node.name.text;
            } else if (ts.isClassDeclaration(node) && node.name) {
                type = 'class';
                name = node.name.text;
            } else if (ts.isInterfaceDeclaration(node)) {
                type = 'interface';
                name = node.name.text;
            } else if (ts.isVariableStatement(node)) {
                type = 'variable';
                name = node.declarationList.declarations[0].name.getText(sourceFile);
            }

            if (name) {
                const { line: startLine } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
                const { line: endLine } = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
                structure.push({
                    type,
                    name,
                    startLine: startLine + 1,
                    endLine: endLine + 1
                });
            }

            ts.forEachChild(node, visit);
        };

        visit(sourceFile);
        return structure;
    }

    detectSyntaxErrors(content: string): { line: number; column: number; message: string; }[] {
        const fileName = 'temp.ts';
        const sourceFile = ts.createSourceFile(
            fileName,
            content,
            ts.ScriptTarget.Latest,
            true
        );

        const program = ts.createProgram({
            rootNames: [fileName],
            options: {
                noEmit: true,
                target: ts.ScriptTarget.Latest,
                module: ts.ModuleKind.ESNext,
                strict: true
            },
            host: {
                getSourceFile: (name) => name === fileName ? sourceFile : undefined,
                getDefaultLibFileName: () => 'lib.d.ts',
                writeFile: () => {},
                getCurrentDirectory: () => '/',
                getDirectories: () => [],
                fileExists: () => true,
                readFile: () => '',
                getCanonicalFileName: (f) => f,
                useCaseSensitiveFileNames: () => true,
                getNewLine: () => '\n',
                getEnvironmentVariable: () => ''
            }
        });

        const diagnostics = [
            ...program.getSyntacticDiagnostics(sourceFile),
            ...program.getSemanticDiagnostics(sourceFile)
        ];

        return diagnostics.map(diagnostic => {
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(diagnostic.start!);
            return {
                line: line + 1,
                column: character + 1,
                message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
            };
        });
    }
}
