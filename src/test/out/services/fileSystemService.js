"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileSystemService = void 0;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const registry_1 = require("../languages/registry");
class FileSystemService {
    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('File System Service');
        this.languageRegistry = registry_1.LanguageRegistry.getInstance();
    }
    getLanguageHandler(filePath) {
        return this.languageRegistry.getHandlerForFile(filePath);
    }
    async analyzeFile(filePath) {
        try {
            const exists = fs.existsSync(filePath);
            if (!exists) {
                return { exists: false, isDirectory: false };
            }
            const stats = fs.statSync(filePath);
            const analysis = {
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
            }
            else {
                // Only read and analyze content for text files and limit size
                if (this.isTextFile(filePath) && stats.size < 1024 * 1024) { // 1MB limit
                    const content = await fs.promises.readFile(filePath, 'utf-8');
                    analysis.content = content;
                    // Perform language-specific analysis if handler exists
                    const handler = this.getLanguageHandler(filePath);
                    if (handler) {
                        analysis.languageAnalysis = {
                            language: handler.languageId,
                            imports: handler.analyzeImports(content),
                            dependencies: handler.analyzeDependencies(content),
                            structure: handler.analyzeStructure(content),
                            syntaxErrors: handler.detectSyntaxErrors(content)
                        };
                    }
                }
            }
            // Get git status if in a git repository
            analysis.gitStatus = await this.getGitStatus(filePath);
            return analysis;
        }
        catch (error) {
            this.logError('Error analyzing file:', error);
            throw error;
        }
    }
    async validateFileOperation(operation, filePath) {
        try {
            const analysis = await this.analyzeFile(filePath);
            const workspaceContext = this.getWorkspaceContext();
            if (!workspaceContext) {
                return {
                    safe: false,
                    reason: 'No workspace folder found'
                };
            }
            const workspace = workspaceContext.workspacePath;
            // Check if file is within workspace
            if (!filePath.startsWith(workspace)) {
                return {
                    safe: false,
                    reason: 'File operation outside workspace is not allowed'
                };
            }
            // Check file existence based on operation
            if (operation === 'create' && analysis.exists) {
                return {
                    safe: false,
                    reason: 'File already exists'
                };
            }
            if (['read', 'write', 'delete'].includes(operation) && !analysis.exists) {
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
        }
        catch (error) {
            this.logError('Error validating file operation:', error);
            return {
                safe: false,
                reason: `Error validating operation: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }
    async analyzeWorkspaceForFile(targetPath) {
        const workspaceContext = this.getWorkspaceContext();
        if (!workspaceContext) {
            throw new Error('No workspace folder found');
        }
        const workspace = workspaceContext.workspacePath;
        const targetName = path.basename(targetPath);
        const targetExt = path.extname(targetPath);
        const targetDir = path.dirname(targetPath);
        const similarFiles = [];
        const existingStructure = {};
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
            }
            else {
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
                .filter(([_, info]) => info.examples.some(f => path.extname(f) === targetExt))
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
    async getAllFilesInWorkspace(workspace) {
        const files = [];
        async function walk(dir) {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
                        await walk(fullPath);
                    }
                }
                else {
                    files.push(fullPath);
                }
            }
        }
        await walk(workspace);
        return files;
    }
    async calculateFileSimilarity(targetPath, existingPath) {
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
    calculateStringSimilarity(str1, str2) {
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
                }
                else {
                    currentValue = Math.min(costs[j - 1], costs[j], previousValue) + 1;
                }
                costs[j - 1] = previousValue;
                previousValue = currentValue;
            }
            costs[shorter.length] = previousValue;
        }
        return (longer.length - costs[shorter.length]) / longer.length;
    }
    calculateArraySimilarity(arr1, arr2) {
        const intersection = arr1.filter(x => arr2.includes(x));
        const union = Array.from(new Set([...arr1, ...arr2]));
        return intersection.length / union.length;
    }
    getSimilarityReason(targetPath, existingPath) {
        const reasons = [];
        const targetExt = path.extname(targetPath);
        const existingExt = path.extname(existingPath);
        if (targetExt === existingExt) {
            reasons.push(`Same file type (${targetExt})`);
        }
        const targetDir = path.dirname(targetPath);
        const existingDir = path.dirname(existingPath);
        if (targetDir === existingDir) {
            reasons.push('Same directory');
        }
        else if (existingDir.includes(targetDir) || targetDir.includes(existingDir)) {
            reasons.push('Related directory structure');
        }
        const targetName = path.basename(targetPath, targetExt);
        const existingName = path.basename(existingPath, existingExt);
        if (targetName.includes(existingName) || existingName.includes(targetName)) {
            reasons.push('Similar name');
        }
        return reasons.join(', ');
    }
    async checkReadPermission(filePath) {
        try {
            await fs.promises.access(filePath, fs.constants.R_OK);
            return true;
        }
        catch {
            return false;
        }
    }
    async checkWritePermission(filePath) {
        try {
            await fs.promises.access(filePath, fs.constants.W_OK);
            return true;
        }
        catch {
            return false;
        }
    }
    async formatFileContent(filePath, content) {
        const handler = this.getLanguageHandler(filePath);
        if (handler) {
            return handler.formatCode(content);
        }
        return content;
    }
    async injectImports(filePath, content, imports) {
        const handler = this.getLanguageHandler(filePath);
        if (handler) {
            return handler.injectImports(content, imports);
        }
        return content;
    }
    async wrapInFunction(filePath, content, functionName) {
        const handler = this.getLanguageHandler(filePath);
        if (handler) {
            return handler.wrapInFunction(content, functionName);
        }
        return content;
    }
    async generateFunction(filePath, name, params, returnType, body) {
        const handler = this.getLanguageHandler(filePath);
        if (handler) {
            return handler.generateFunction(name, params, returnType, body);
        }
        return '';
    }
    async generateClass(filePath, name, properties, methods) {
        const handler = this.getLanguageHandler(filePath);
        if (handler) {
            return handler.generateClass(name, properties, methods);
        }
        return '';
    }
    isTextFile(filePath) {
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
    async getGitStatus(filePath) {
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
        }
        catch {
            return undefined;
        }
    }
    async executeCommand(command, args) {
        return new Promise((resolve) => {
            const { exec } = require('child_process');
            exec(`${command} ${args.join(' ')}`, (error, stdout, stderr) => {
                resolve({ stdout, stderr, error });
            });
        });
    }
    logError(message, error) {
        if (error instanceof Error) {
            this.outputChannel.appendLine(`${message} ${error.message}`);
            if (error.stack) {
                this.outputChannel.appendLine(error.stack);
            }
        }
        else {
            this.outputChannel.appendLine(`${message} ${String(error)}`);
        }
    }
    convertToWslPath(windowsPath) {
        // Convert Windows path to WSL path
        if (windowsPath.startsWith('\\\\wsl')) {
            const parts = windowsPath.split('\\');
            // Remove empty parts and 'wsl.localhost'
            const relevantParts = parts.filter(p => p && p !== 'wsl.localhost');
            // Remove distribution name (e.g., Ubuntu-22.04)
            relevantParts.splice(1, 1);
            return '/' + relevantParts.join('/');
        }
        return windowsPath;
    }
    convertToWindowsPath(wslPath) {
        // Convert WSL path to Windows path
        if (wslPath.startsWith('/')) {
            const distro = 'Ubuntu-22.04'; // You might want to make this configurable
            return `\\\\wsl.localhost\\${distro}${wslPath}`;
        }
        return wslPath;
    }
    getWorkspaceContext() {
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
}
exports.FileSystemService = FileSystemService;
//# sourceMappingURL=fileSystemService.js.map