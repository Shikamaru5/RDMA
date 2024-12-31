import { BaseLanguageHandler } from './base';

export class PythonHandler extends BaseLanguageHandler {
    readonly fileExtensions = ['.py'];
    readonly languageId = 'python';
    readonly importPatterns = [
        /from\s+(\S+)\s+import\s+/g,
        /import\s+(\S+)/g
    ];
    readonly dependencyPatterns = [
        /requirements\.txt/g,
        /setup\.py/g,
        /pyproject\.toml/g,
        /Pipfile/g,
        /\.env/g,
        /\.venv/g,
        /venv/g
    ];
    readonly functionPatterns = [
        /def\s+(\w+)\s*\(([^)]*)\)/g,
        /async\s+def\s+(\w+)\s*\(([^)]*)\)/g
    ];
    readonly classPatterns = [
        /class\s+(\w+)(?:\([^)]+\))?\s*:/g
    ];
    readonly blockPatterns = [
        /:\s*\n\s+[^\n]+(?:\n\s+[^\n]+)*/g
    ];

    protected parseImport(match: RegExpMatchArray): string {
        const fromModule = match[1];
        const imports = match[2];
        if (fromModule) {
            return fromModule;
        }
        return imports.split(',')[0].trim().split(' ')[0];
    }

    protected parseFunction(match: RegExpMatchArray): { name: string; params: string[]; returnType?: string; } {
        const [_, name, params = '', returnType = ''] = match;
        return {
            name,
            params: params.split(',').map(p => p.trim()).filter(Boolean),
            returnType: returnType.trim() || undefined
        };
    }

    analyzeDependencies(content: string): string[] {
        const dependencies = new Set<string>();
        const lines = content.split('\n');

        for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine.startsWith('import ') || trimmedLine.startsWith('from ')) {
                const match = trimmedLine.match(/^(?:from\s+(\S+)\s+)?import\s+([^#]+)/);
                if (match) {
                    const [_, fromModule, imports] = match;
                    if (fromModule) {
                        dependencies.add(fromModule.split('.')[0]);
                    } else {
                        imports.split(',').forEach(imp => {
                            const moduleName = imp.trim().split(' ')[0].split('.')[0];
                            dependencies.add(moduleName);
                        });
                    }
                }
            }
        }

        return Array.from(dependencies);
    }

    analyzeFunctions(content: string): { name: string; params: string[]; returnType?: string; complexity: number; }[] {
        const functions: { name: string; params: string[]; returnType?: string; complexity: number; }[] = [];
        const lines = content.split('\n');
        let currentFunction: { name: string; params: string[]; returnType?: string; complexity: number; } | null = null;
        let indentLevel = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const match = line.match(/def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?\s*:/);
            
            if (match) {
                if (currentFunction) {
                    functions.push(currentFunction);
                }
                
                const [_, name, params = '', returnType = ''] = match;
                currentFunction = {
                    name,
                    params: params.split(',').map(p => p.trim()).filter(Boolean),
                    returnType: returnType.trim() || undefined,
                    complexity: this.calculateComplexity(lines.slice(i))
                };
            }
        }

        if (currentFunction) {
            functions.push(currentFunction);
        }

        return functions;
    }

    private calculateComplexity(lines: string[]): number {
        let complexity = 1;
        const complexityPatterns = [
            /\bif\b/,
            /\belif\b/,
            /\bfor\b/,
            /\bwhile\b/,
            /\bcatch\b/,
            /\band\b/,
            /\bor\b/
        ];

        for (const line of lines) {
            for (const pattern of complexityPatterns) {
                if (pattern.test(line)) {
                    complexity++;
                }
            }
        }

        return complexity;
    }

    analyzeStructure(content: string): { type: 'class' | 'function' | 'interface' | 'variable' | 'other'; name: string; startLine: number; endLine: number; }[] {
        const structures: { type: 'class' | 'function' | 'interface' | 'variable' | 'other'; name: string; startLine: number; endLine: number; }[] = [];
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            // Check for class definitions
            const classMatch = line.match(/class\s+(\w+)(?:\([^)]*\))?\s*:/);
            if (classMatch) {
                const name = classMatch[1];
                const endLine = this.findBlockEnd(lines, i);
                structures.push({
                    type: 'class',
                    name,
                    startLine: i,
                    endLine
                });
                continue;
            }

            // Check for function definitions
            const funcMatch = line.match(/def\s+(\w+)\s*\(/);
            if (funcMatch) {
                const name = funcMatch[1];
                const endLine = this.findBlockEnd(lines, i);
                structures.push({
                    type: 'function',
                    name,
                    startLine: i,
                    endLine
                });
                continue;
            }

            // Check for variable assignments
            const varMatch = line.match(/^(\w+)\s*=/);
            if (varMatch && !line.trim().startsWith('def') && !line.trim().startsWith('class')) {
                structures.push({
                    type: 'variable',
                    name: varMatch[1],
                    startLine: i,
                    endLine: i
                });
            }
        }

        return structures;
    }

    private findBlockEnd(lines: string[], startLine: number): number {
        const startIndent = this.getIndentLevel(lines[startLine]);
        
        for (let i = startLine + 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line === '') continue;
            
            const currentIndent = this.getIndentLevel(lines[i]);
            if (currentIndent <= startIndent && line !== '') {
                return i - 1;
            }
        }
        
        return lines.length - 1;
    }

    private getIndentLevel(line: string): number {
        const match = line.match(/^(\s*)/);
        return match ? match[1].length : 0;
    }

    detectSyntaxErrors(content: string): { line: number; column: number; message: string; }[] {
        const errors: { line: number; column: number; message: string; }[] = [];
        const lines = content.split('\n');
        let indentStack: number[] = [0];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const indent = this.getIndentLevel(line);
            const trimmedLine = line.trim();

            if (trimmedLine === '') continue;

            // Check indentation
            if (indent > indentStack[indentStack.length - 1]) {
                indentStack.push(indent);
            } else if (indent < indentStack[indentStack.length - 1]) {
                while (indentStack[indentStack.length - 1] > indent) {
                    indentStack.pop();
                }
                if (indentStack[indentStack.length - 1] !== indent) {
                    errors.push({
                        line: i,
                        column: 0,
                        message: 'Invalid indentation'
                    });
                }
            }

            // Check for syntax errors in function definitions
            if (trimmedLine.startsWith('def ')) {
                if (!trimmedLine.includes('(') || !trimmedLine.includes(')') || !trimmedLine.endsWith(':')) {
                    errors.push({
                        line: i,
                        column: line.indexOf('def'),
                        message: 'Invalid function definition syntax'
                    });
                }
            }

            // Check for syntax errors in class definitions
            if (trimmedLine.startsWith('class ')) {
                if (!trimmedLine.endsWith(':')) {
                    errors.push({
                        line: i,
                        column: line.indexOf('class'),
                        message: 'Invalid class definition syntax'
                    });
                }
            }

            // Check for unmatched parentheses
            const openParens = (line.match(/\(/g) || []).length;
            const closeParens = (line.match(/\)/g) || []).length;
            if (openParens !== closeParens) {
                errors.push({
                    line: i,
                    column: line.indexOf('('),
                    message: 'Unmatched parentheses'
                });
            }
        }

        return errors;
    }

    generateImports(dependencies: string[]): string {
        return dependencies
            .map(dep => `import ${dep}`)
            .join('\n');
    }

    generateFunction(name: string, params: string[], returnType: string, body: string): string {
        const paramsList = params.join(', ');
        const returnAnnotation = returnType ? ` -> ${returnType}` : '';
        return `def ${name}(${paramsList})${returnAnnotation}:\n${this.indentCode(body)}`;
    }

    generateClass(name: string, properties: string[], methods: string[]): string {
        const props = properties.map(p => `    ${p}`).join('\n');
        const meths = methods.map(m => this.indentCode(m)).join('\n\n');
        return `class ${name}:\n${props}\n\n${meths}`;
    }

    private indentCode(code: string, spaces: number = 4): string {
        return code.split('\n')
            .map(line => ' '.repeat(spaces) + line)
            .join('\n');
    }

    validateSyntax(content: string): boolean {
        return this.detectSyntaxErrors(content).length === 0;
    }

    validateImports(content: string): boolean {
        const imports = this.analyzeImports(content);
        const lines = content.split('\n');
        
        // Check if imports are at the top of the file
        let foundCodeBeforeImports = false;
        let foundImportAfterCode = false;
        
        for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine === '' || trimmedLine.startsWith('#')) continue;
            
            if (!trimmedLine.startsWith('import ') && !trimmedLine.startsWith('from ')) {
                foundCodeBeforeImports = true;
            } else if (foundCodeBeforeImports) {
                foundImportAfterCode = true;
                break;
            }
        }
        
        return !foundImportAfterCode;
    }

    validateStructure(content: string): boolean {
        const lines = content.split('\n');
        let insideClass = false;
        let hasInit = false;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            if (line.startsWith('class ')) {
                if (insideClass) {
                    // Nested classes are not recommended
                    return false;
                }
                insideClass = true;
                hasInit = false;
            } else if (insideClass && line.startsWith('def __init__')) {
                hasInit = true;
            } else if (line && this.getIndentLevel(lines[i]) === 0) {
                if (insideClass) {
                    insideClass = false;
                    if (!hasInit) {
                        // Class without __init__ method
                        return false;
                    }
                }
            }
        }
        
        return true;
    }

    formatCode(content: string): string {
        const lines = content.split('\n');
        let formattedLines: string[] = [];
        let currentIndent = 0;
        
        for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine === '') {
                formattedLines.push('');
                continue;
            }
            
            if (trimmedLine.startsWith('class ') || trimmedLine.startsWith('def ')) {
                if (formattedLines.length > 0 && formattedLines[formattedLines.length - 1] !== '') {
                    formattedLines.push('');
                }
            }
            
            if (trimmedLine.endsWith(':')) {
                formattedLines.push(' '.repeat(currentIndent) + trimmedLine);
                currentIndent += 4;
            } else if (trimmedLine.startsWith('return ') || trimmedLine.startsWith('break') || trimmedLine.startsWith('continue')) {
                currentIndent = Math.max(0, currentIndent - 4);
                formattedLines.push(' '.repeat(currentIndent) + trimmedLine);
            } else {
                formattedLines.push(' '.repeat(currentIndent) + trimmedLine);
            }
        }
        
        return formattedLines.join('\n');
    }

    injectImports(content: string, imports: string[]): string {
        const existingImports = this.analyzeImports(content);
        const newImports = imports.filter(imp => !existingImports.includes(imp));
        
        if (newImports.length === 0) {
            return content;
        }
        
        const importStatements = this.generateImports(newImports);
        const lines = content.split('\n');
        let lastImportIndex = -1;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith('import ') || line.startsWith('from ')) {
                lastImportIndex = i;
            } else if (line !== '' && !line.startsWith('#')) {
                break;
            }
        }
        
        if (lastImportIndex === -1) {
            return importStatements + '\n\n' + content;
        } else {
            lines.splice(lastImportIndex + 1, 0, importStatements);
            return lines.join('\n');
        }
    }

    wrapInFunction(content: string, functionName: string): string {
        return `def ${functionName}():\n${this.indentCode(content)}`;
    }
}
