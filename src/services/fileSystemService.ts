import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LanguageRegistry } from '../languages/registry';
import { LanguageHandler } from '../languages/base';
import { CodeAnalysisService } from './codeAnalysisService';

export interface FileAnalysis {
    exists: boolean;
    isDirectory: boolean;
    size?: number;
    lastModified?: Date;
    lineCount?: number;  // Add line count property
    permissions?: {
        readable: boolean;
        writable: boolean;
    };
    children?: string[];
    content?: string;
    gitStatus?: {
        tracked: boolean;
        modified: boolean;
    };
    languageAnalysis?: {
        language: string;
        imports: string[];
        dependencies: string[];
        structure: Array<{
            type: 'class' | 'function' | 'interface' | 'variable' | 'other';
            name: string;
            startLine: number;
            endLine: number;
        }>;
        syntaxErrors: Array<{
            line: number;
            column: number;
            message: string;
        }>;
        impactedFiles?: string[];  // Add impactedFiles field
    };
}

export interface WorkspaceAnalysis {
    similarFiles: Array<{
        path: string;
        similarity: number;
        reason: string;
    }>;
    suggestedLocation?: string;
    existingStructure: {
        [key: string]: {
            type: 'file' | 'directory';
            count: number;
            examples: string[];
        }
    };
}

export class FileSystemService {
    private outputChannel: vscode.OutputChannel;
    private languageRegistry: LanguageRegistry;
    public codeAnalysis: CodeAnalysisService;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('File System Service');
        this.languageRegistry = LanguageRegistry.getInstance();
        this.codeAnalysis = new CodeAnalysisService(this);
    }

    getCodeAnalysis(): CodeAnalysisService {
        return this.codeAnalysis;
    }

    private getLanguageHandler(filePath: string): LanguageHandler | undefined {
        return this.languageRegistry.getHandlerForFile(filePath);
    }

    async analyzeFile(filePath: string): Promise<FileAnalysis> {
        try {
            const exists = fs.existsSync(filePath);
            if (!exists) {
                return { exists: false, isDirectory: false };
            }

            const stats = fs.statSync(filePath);
            const analysis: FileAnalysis = {
                exists: true,
                isDirectory: stats.isDirectory(),
                size: stats.size,
                lastModified: stats.mtime,
                permissions: {
                    readable: await this.checkReadPermission(filePath),
                    writable: await this.checkWritePermission(filePath)
                }
            };

            if (analysis.isDirectory) {
                analysis.children = await fs.promises.readdir(filePath);
            } else {
                // Only read and analyze content for text files and limit size
                if (this.isTextFile(filePath) && stats.size < 2048 * 2048) { // 4MB limit
                    const content = await fs.promises.readFile(filePath, 'utf-8');
                    analysis.content = content;
                    analysis.lineCount = content.split('\n').length;  // Add line count to analysis

                    // Perform language-specific analysis if handler exists
                    const handler = this.getLanguageHandler(filePath);
                    if (handler) {
                        // Initialize TypeScript program if needed
                        if (handler.languageId === 'typescript') {
                            await this.codeAnalysis.initializeTypeScript(path.dirname(filePath));
                        }

                        // Get type checking results
                        const typeCheck = await this.codeAnalysis.checkTypes(filePath);

                        // Get base analysis from handler
                        const baseAnalysis = {
                            language: handler.languageId,
                            imports: handler.analyzeImports(content),
                            dependencies: handler.analyzeDependencies(content),
                            structure: handler.analyzeStructure(content),
                            syntaxErrors: handler.detectSyntaxErrors(content)
                        };

                        // Add type checking errors if available
                        if (typeCheck.errors.length > 0) {
                            baseAnalysis.syntaxErrors.push(
                                ...typeCheck.errors.map(e => ({
                                    line: e.location.range.startLine,
                                    column: e.location.range.startColumn,
                                    message: e.message
                                }))
                            );
                        }

                        // Build dependency graph if needed
                        const workspaceContext = this.getWorkspaceContext();
                        if (workspaceContext) {
                            await this.codeAnalysis.buildDependencyGraph(workspaceContext.workspacePath);
                        }

                        // Add impacted files
                        const impactedFiles = this.codeAnalysis.getImpactedFiles(filePath);
                        
                        analysis.languageAnalysis = {
                            ...baseAnalysis,
                            impactedFiles
                        };
                    }
                }
            }

            // Get git status if in a git repository
            analysis.gitStatus = await this.getGitStatus(filePath);

            return analysis;
        } catch (error) {
            this.logError('Error analyzing file:', error);
            throw error;
        }
    }

    async validateFileOperation(operation: 'read' | 'write' | 'create' | 'delete', filePath: string): Promise<{
        safe: boolean;
        reason: string;
    }> {
        try {
            const workspaceContext = this.getWorkspaceContext();
            if (!workspaceContext) {
                return {
                    safe: false,
                    reason: 'No workspace folder found'
                };
            }

            const workspace = workspaceContext.workspacePath;

            // Normalize paths for comparison
            const normalizedFilePath = this.convertToWslPath(filePath);
            const normalizedWorkspace = this.convertToWslPath(workspace);

            // Check if file is within workspace
            if (!normalizedFilePath.startsWith(normalizedWorkspace)) {
                // For edit operations, try to resolve relative to test_ollama directory
                if (operation === 'write') {
                    const testOllamaPath = path.join(normalizedWorkspace, 'test_ollama', path.basename(filePath));
                    if (fs.existsSync(testOllamaPath)) {
                        return {
                            safe: true,
                            reason: 'File found in test_ollama directory'
                        };
                    }
                }
                
                return {
                    safe: false,
                    reason: 'File operation outside workspace is not allowed'
                };
            }

            // For create operations, check if parent directory exists or can be created
            if (operation === 'create') {
                const dirPath = path.dirname(filePath);
                try {
                    // Create directory if it doesn't exist
                    if (!fs.existsSync(dirPath)) {
                        fs.mkdirSync(dirPath, { recursive: true });
                    }
                    return {
                        safe: true,
                        reason: 'Directory exists or was created'
                    };
                } catch (error) {
                    return {
                        safe: false,
                        reason: `Cannot create directory structure: ${error instanceof Error ? error.message : String(error)}`
                    };
                }
            }

            // For other operations, check file existence
            const analysis = await this.analyzeFile(filePath);
            
            // For write operations, also check test_ollama directory
            if (operation === 'write' && !analysis.exists) {
                const testOllamaPath = path.join(workspace, 'test_ollama', path.basename(filePath));
                const testOllamaAnalysis = await this.analyzeFile(testOllamaPath);
                if (testOllamaAnalysis.exists) {
                    return {
                        safe: true,
                        reason: 'File exists in test_ollama directory'
                    };
                }
            }
            
            // Only check file existence for operations that require the file to exist
            if (['read', 'write', 'delete'].includes(operation)) {
                if (!analysis.exists) {
                    return {
                        safe: false,
                        reason: 'File does not exist'
                    };
                }

                // Check permissions
                if (operation === 'read' && !analysis.permissions?.readable) {
                    return {
                        safe: false,
                        reason: 'File is not readable'
                    };
                }

                if (['write', 'delete'].includes(operation) && !analysis.permissions?.writable) {
                    return {
                        safe: false,
                        reason: 'File is not writable'
                    };
                }
            }

            // Check file type restrictions
            const restrictedExtensions = ['.exe', '.dll', '.sys', '.bin'];
            if (restrictedExtensions.includes(path.extname(filePath))) {
                return {
                    safe: false,
                    reason: 'Operation not allowed on binary/system files'
                };
            }

            // Validate language-specific constraints
            if (operation === 'write' && analysis.content) {
                const handler = this.getLanguageHandler(filePath);
                if (handler) {
                    const isValidSyntax = handler.validateSyntax(analysis.content);
                    const isValidImports = handler.validateImports(analysis.content);
                    const isValidStructure = handler.validateStructure(analysis.content);

                    if (!isValidSyntax || !isValidImports || !isValidStructure) {
                        return {
                            safe: false,
                            reason: 'File contains invalid code structure or syntax'
                        };
                    }
                }
            }

            // Check git status
            if (analysis.gitStatus?.tracked && analysis.gitStatus?.modified) {
                // We'll allow it but warn the user
                return {
                    safe: true,
                    reason: 'Warning: File is tracked by git and has uncommitted changes'
                };
            }

            return {
                safe: true,
                reason: 'Operation is safe to proceed'
            };
        } catch (error) {
            this.logError('Error validating file operation:', error);
            return {
                safe: false,
                reason: `Error validating operation: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }

    async validateDirectoryOperation(
        operation: 'create' | 'delete', 
        dirPath: string
    ): Promise<{ safe: boolean; reason: string }> {
        try {
            const workspaceContext = this.getWorkspaceContext();
            if (!workspaceContext) {
                return {
                    safe: false,
                    reason: 'No workspace folder found'
                };
            }
    
            // Normalize paths for comparison
            const normalizedDirPath = this.convertToWslPath(dirPath);
            const normalizedWorkspace = this.convertToWslPath(workspaceContext.workspacePath);
    
            // Check if directory is within workspace
            if (!normalizedDirPath.startsWith(normalizedWorkspace)) {
                return {
                    safe: false,
                    reason: 'Directory operation outside workspace is not allowed'
                };
            }
    
            // Check permissions
            if (operation === 'create') {
                const parentDir = path.dirname(dirPath);
                if (!await this.checkWritePermission(parentDir)) {
                    return {
                        safe: false,
                        reason: 'No write permission in parent directory'
                    };
                }
            }
    
            // Check git status if relevant
            const gitStatus = await this.getGitStatus(dirPath);
            if (gitStatus?.tracked && gitStatus?.modified) {
                return {
                    safe: true,
                    reason: 'Warning: Directory is tracked by git and has uncommitted changes'
                };
            }
    
            return {
                safe: true,
                reason: 'Operation is safe to proceed'
            };
        } catch (error) {
            return {
                safe: false,
                reason: `Error validating operation: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }

    async analyzeWorkspaceForFile(targetPath: string): Promise<WorkspaceAnalysis> {
        const workspaceContext = this.getWorkspaceContext();
        if (!workspaceContext) {
            throw new Error('No workspace folder found');
        }

        const workspace = workspaceContext.workspacePath;
        const targetName = path.basename(targetPath);
        const targetExt = path.extname(targetPath);
        const targetDir = path.dirname(targetPath);
        const similarFiles: Array<{ path: string; similarity: number; reason: string }> = [];
        const existingStructure: WorkspaceAnalysis['existingStructure'] = {};

        // Get all files in workspace
        const allFiles = await this.getAllFilesInWorkspace(workspace);

        // Analyze existing structure
        for (const file of allFiles) {
            const relPath = path.relative(workspace, file);
            const dir = path.dirname(relPath);
            const ext = path.extname(file);

            // Track directory structure
            if (!existingStructure[dir]) {
                existingStructure[dir] = {
                    type: 'directory',
                    count: 1,
                    examples: [file]
                };
            } else {
                existingStructure[dir].count++;
                if (existingStructure[dir].examples.length < 3) {
                    existingStructure[dir].examples.push(file);
                }
            }

            // Check for similar files
            const similarity = await this.calculateFileSimilarity(targetPath, file);
            if (similarity > 0.5) { // More than 50% similar
                similarFiles.push({
                    path: file,
                    similarity,
                    reason: this.getSimilarityReason(targetPath, file)
                });
            }
        }

        // Suggest best location based on existing structure
        let suggestedLocation = targetDir;
        if (targetExt) {
            // Find directories with similar file types
            const dirsWithSameExt = Object.entries(existingStructure)
                .filter(([_, info]) => 
                    info.examples.some(f => path.extname(f) === targetExt))
                .sort((a, b) => b[1].count - a[1].count);

            if (dirsWithSameExt.length > 0) {
                suggestedLocation = dirsWithSameExt[0][0];
            }
        }

        return {
            similarFiles,
            suggestedLocation: suggestedLocation !== targetDir ? suggestedLocation : undefined,
            existingStructure
        };
    }

    public async getAllFilesInWorkspace(workspace: string): Promise<string[]> {
        const files: string[] = [];
        
        async function walk(dir: string) {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
                        await walk(fullPath);
                    }
                } else {
                    files.push(fullPath);
                }
            }
        }

        await walk(workspace);
        return files;
    }

    private async calculateFileSimilarity(targetPath: string, existingPath: string): Promise<number> {
        const targetName = path.basename(targetPath);
        const existingName = path.basename(existingPath);
        const targetExt = path.extname(targetPath);
        const existingExt = path.extname(existingPath);

        let similarity = 0;

        // Extension similarity
        if (targetExt === existingExt) {
            similarity += 0.3;
        }

        // Name similarity (excluding extension)
        const targetBaseName = path.basename(targetPath, targetExt);
        const existingBaseName = path.basename(existingPath, existingExt);
        const nameSimilarity = this.calculateStringSimilarity(targetBaseName, existingBaseName);
        similarity += nameSimilarity * 0.4;

        // Directory structure similarity
        const targetDirParts = path.dirname(targetPath).split(path.sep);
        const existingDirParts = path.dirname(existingPath).split(path.sep);
        const dirSimilarity = this.calculateArraySimilarity(targetDirParts, existingDirParts);
        similarity += dirSimilarity * 0.3;

        return similarity;
    }

    private calculateStringSimilarity(str1: string, str2: string): number {
        const longer = str1.length > str2.length ? str1 : str2;
        const shorter = str1.length > str2.length ? str2 : str1;
        
        if (longer.length === 0) {
            return 1.0;
        }

        const costs = new Array(shorter.length + 1);
        for (let i = 0; i <= shorter.length; i++) {
            costs[i] = i;
        }

        let currentValue;
        for (let i = 1; i <= longer.length; i++) {
            let previousValue = i;
            for (let j = 1; j <= shorter.length; j++) {
                if (longer[i - 1] === shorter[j - 1]) {
                    currentValue = costs[j - 1];
                } else {
                    currentValue = Math.min(costs[j - 1], costs[j], previousValue) + 1;
                }
                costs[j - 1] = previousValue;
                previousValue = currentValue;
            }
            costs[shorter.length] = previousValue;
        }

        return (longer.length - costs[shorter.length]) / longer.length;
    }

    private calculateArraySimilarity(arr1: string[], arr2: string[]): number {
        const intersection = arr1.filter(x => arr2.includes(x));
        const union = Array.from(new Set([...arr1, ...arr2]));
        return intersection.length / union.length;
    }

    private getSimilarityReason(targetPath: string, existingPath: string): string {
        const reasons: string[] = [];
        const targetExt = path.extname(targetPath);
        const existingExt = path.extname(existingPath);
        
        if (targetExt === existingExt) {
            reasons.push(`Same file type (${targetExt})`);
        }

        const targetDir = path.dirname(targetPath);
        const existingDir = path.dirname(existingPath);
        if (targetDir === existingDir) {
            reasons.push('Same directory');
        } else if (existingDir.includes(targetDir) || targetDir.includes(existingDir)) {
            reasons.push('Related directory structure');
        }

        const targetName = path.basename(targetPath, targetExt);
        const existingName = path.basename(existingPath, existingExt);
        if (targetName.includes(existingName) || existingName.includes(targetName)) {
            reasons.push('Similar name');
        }

        return reasons.join(', ');
    }

    private async checkReadPermission(filePath: string): Promise<boolean> {
        try {
            await fs.promises.access(filePath, fs.constants.R_OK);
            return true;
        } catch {
            return false;
        }
    }

    private async checkWritePermission(filePath: string): Promise<boolean> {
        try {
            await fs.promises.access(filePath, fs.constants.W_OK);
            return true;
        } catch {
            return false;
        }
    }

    async formatFileContent(filePath: string, content: string): Promise<string> {
        try {
            const handler = this.getLanguageHandler(filePath);
            if (!handler) {
                return content; // Return as-is if no handler found
            }

            // Format the content using the language handler
            let formattedContent = content;

            // Add necessary imports
            const imports = handler.analyzeImports(content);
            formattedContent = await this.injectImports(filePath, formattedContent, imports);

            // Validate syntax
            const syntaxErrors = handler.detectSyntaxErrors(formattedContent);
            if (syntaxErrors.length > 0) {
                this.outputChannel.appendLine('Syntax errors detected:');
                syntaxErrors.forEach(error => {
                    this.outputChannel.appendLine(`Line ${error.line}: ${error.message}`);
                });
            }

            return formattedContent;
        } catch (error) {
            this.logError('Error formatting file content:', error);
            return content; // Return original content if formatting fails
        }
    }

    async writeFile(filePath: string, content: string): Promise<void> {
        try {
            // Get workspace context
            const context = this.getWorkspaceContext();
            if (!context) {
                throw new Error('No workspace found');
            }

            // Handle relative paths
            let fullPath: string;
            if (path.isAbsolute(filePath)) {
                // If absolute path is within workspace, allow it
                const relativePath = path.relative(context.workspacePath, filePath);
                if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
                    throw new Error('Cannot write to files outside workspace');
                }
                fullPath = filePath;
            } else {
                // Convert relative path to absolute using workspace root
                fullPath = path.join(context.workspacePath, filePath);
            }

            // Convert path format if needed
            const normalizedPath = context.isWsl ? this.convertToWslPath(fullPath) : fullPath;

            // Validate the operation
            const validation = await this.validateFileOperation('write', normalizedPath);
            if (!validation.safe) {
                throw new Error(`Unsafe file operation: ${validation.reason}`);
            }

            // Ensure the directory exists
            const dirPath = path.dirname(normalizedPath);
            if (!fs.existsSync(dirPath)) {
                fs.mkdirSync(dirPath, { recursive: true });
            }

            // Format content before writing
            const formattedContent = await this.formatFileContent(normalizedPath, content);

            // Write the file
            await fs.promises.writeFile(normalizedPath, formattedContent, 'utf-8');
            this.outputChannel.appendLine(`Successfully wrote file: ${normalizedPath}`);
        } catch (error) {
            this.logError('Failed to write file:', error);
            throw error;
        }
    }

    async readFile(filePath: string): Promise<string> {
        try {
            const validation = await this.validateFileOperation('read', filePath);
            if (!validation.safe) {
                throw new Error(`Unsafe file operation: ${validation.reason}`);
            }

            return await fs.promises.readFile(filePath, 'utf8');
        } catch (error) {
            this.logError('Error reading file:', error);
            throw error;
        }
    }

    async injectImports(filePath: string, content: string, imports: string[]): Promise<string> {
        const handler = this.getLanguageHandler(filePath);
        if (handler) {
            return handler.injectImports(content, imports);
        }
        return content;
    }

    async wrapInFunction(filePath: string, content: string, functionName: string): Promise<string> {
        const handler = this.getLanguageHandler(filePath);
        if (handler) {
            return handler.wrapInFunction(content, functionName);
        }
        return content;
    }

    async generateFunction(
        filePath: string,
        name: string,
        params: string[],
        returnType: string,
        body: string
    ): Promise<string> {
        const handler = this.getLanguageHandler(filePath);
        if (handler) {
            return handler.generateFunction(name, params, returnType, body);
        }
        return '';
    }

    async generateClass(
        filePath: string,
        name: string,
        properties: string[],
        methods: string[]
    ): Promise<string> {
        const handler = this.getLanguageHandler(filePath);
        if (handler) {
            return handler.generateClass(name, properties, methods);
        }
        return '';
    }

    async createFile(filePath: string, content: string): Promise<void> {
        try {
            // Get workspace context
            const context = this.getWorkspaceContext();
            if (!context) {
                throw new Error('No workspace found');
            }

            // Handle relative paths
            let fullPath: string;
            if (path.isAbsolute(filePath)) {
                // If absolute path is within workspace, allow it
                const relativePath = path.relative(context.workspacePath, filePath);
                if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
                    throw new Error('Cannot create files outside workspace');
                }
                fullPath = filePath;
            } else {
                // Convert relative path to absolute using workspace root
                fullPath = path.join(context.workspacePath, filePath);
            }

            // Convert path format if needed
            const normalizedPath = context.isWsl ? this.convertToWslPath(fullPath) : fullPath;

            // Validate the operation
            const validation = await this.validateFileOperation('create', normalizedPath);
            if (!validation.safe) {
                throw new Error(`Unsafe file operation: ${validation.reason}`);
            }

            // Ensure the directory exists
            const dirPath = path.dirname(normalizedPath);
            if (!fs.existsSync(dirPath)) {
                fs.mkdirSync(dirPath, { recursive: true });
            }

            // Check if file already exists
            if (fs.existsSync(normalizedPath)) {
                throw new Error('File already exists');
            }

            // Format content before writing
            const formattedContent = await this.formatFileContent(normalizedPath, content);

            // Write the file
            await fs.promises.writeFile(normalizedPath, formattedContent, 'utf-8');
            this.outputChannel.appendLine(`Successfully created file: ${normalizedPath}`);
        } catch (error) {
            this.logError('Failed to create file:', error);
            throw error;
        }
    }

    async createDirectory(dirPath: string): Promise<void> {
        try {
            // Get workspace context
            const context = this.getWorkspaceContext();
            if (!context) {
                throw new Error('No workspace found');
            }

            // Handle relative paths
            let fullPath: string;
            if (path.isAbsolute(dirPath)) {
                // If absolute path is within workspace, allow it
                const relativePath = path.relative(context.workspacePath, dirPath);
                if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
                    throw new Error('Cannot create files outside workspace');
                }
                fullPath = dirPath;
            } else {
                // Convert relative path to absolute using workspace root
                fullPath = path.join(context.workspacePath, dirPath);
            }

            // Convert path format if needed
            const normalizedPath = context.isWsl ? this.convertToWslPath(fullPath) : fullPath;

            // Validate the operation
            const validation = await this.validateDirectoryOperation('create', normalizedPath);
            if (!validation.safe) {
                throw new Error(`Unsafe directory operation: ${validation.reason}`);
            }

            // Ensure the directory exists
            const parentDirPath = path.dirname(normalizedPath);
            if (!fs.existsSync(parentDirPath)) {
                fs.mkdirSync(parentDirPath, { recursive: true });
            }

            // Create directory recursively (will create parent directories if they don't exist)
            await fs.promises.mkdir(normalizedPath, { recursive: true });

            this.outputChannel.appendLine(`Created directory: ${normalizedPath}`);
            } catch (error) {
                this.logError(`Error creating directory: ${dirPath}`, error);
                throw error;
            }
        }
    isTextFile(filePath: string): boolean {
        // First check if we have a language handler for this file
        const handler = this.getLanguageHandler(filePath);
        if (handler) {
            return true;
        }

        // Fallback to extension-based check
        const ext = path.extname(filePath).toLowerCase();
        const textExtensions = [
            '.txt', '.md', '.json', '.xml', '.yaml', '.yml',
            '.ini', '.conf', '.config', '.log', '.csv'
        ];
        return textExtensions.includes(ext);
    }

    public getWorkspaceContext(): { workspacePath: string; isWsl: boolean } | undefined {
        const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspace) {
            return undefined;
        }

        // Detect if we're in WSL
        const isWsl = workspace.includes('\\wsl.localhost\\') || workspace.startsWith('/');
        return {
            workspacePath: isWsl ? this.convertToWslPath(workspace) : workspace,
            isWsl
        };
    }

    private async getGitStatus(filePath: string): Promise<{ tracked: boolean; modified: boolean } | undefined> {
        try {
            const gitExec = await this.executeCommand('git', ['status', '--porcelain', filePath]);
            if (gitExec.error) {
                return undefined; // Not in a git repository
            }
            const output = gitExec.stdout.trim();
            return {
                tracked: !output.startsWith('??'),
                modified: output.length > 0
            };
        } catch {
            return undefined;
        }
    }

    private async executeCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string; error?: Error }> {
        return new Promise((resolve) => {
            const { exec } = require('child_process');
            exec(`${command} ${args.join(' ')}`, (error: Error, stdout: string, stderr: string) => {
                resolve({ stdout, stderr, error });
            });
        });
    }

    private logError(message: string, error: unknown): void {
        if (error instanceof Error) {
            this.outputChannel.appendLine(`${message} ${error.message}`);
            if (error.stack) {
                this.outputChannel.appendLine(error.stack);
            }
        } else {
            this.outputChannel.appendLine(`${message} ${String(error)}`);
        }
    }

    private convertToWslPath(windowsPath: string): string {
        // Convert Windows path to WSL path
        if (windowsPath.includes('wsl.localhost')) {
            // Handle both forward and backward slashes
            const normalizedPath = windowsPath.replace(/\\/g, '/');
            const parts = normalizedPath.split('/').filter(p => p);
            // Remove 'wsl.localhost' and distribution name
            const startIndex = parts.findIndex(p => p === 'wsl.localhost');
            if (startIndex !== -1) {
                parts.splice(startIndex, 2);
            }
            return '/' + parts.join('/');
        }
        return windowsPath;
    }

    private convertToWindowsPath(wslPath: string): string {
        // Convert WSL path to Windows path
        if (wslPath.startsWith('/')) {
            const distro = 'Ubuntu-22.04'; // You might want to make this configurable
            return `\\\\wsl.localhost\\${distro}${wslPath}`;
        }
        return wslPath;
    }
}
