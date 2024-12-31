import { BaseLanguageHandler } from './base';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

export class JavaScriptHandler extends BaseLanguageHandler {
    readonly fileExtensions = ['.js', '.jsx'];
    readonly languageId = 'javascript';
    readonly importPatterns = [
        /import\s+.*?from\s+['"]([^'"]+)['"]/g,
        /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    ];
    readonly dependencyPatterns = [
        /package\.json/g,
        /package-lock\.json/g,
        /node_modules/g,
        /webpack\.config\.js/g,
        /babel\.config\.js/g,
        /jest\.config\.js/g
    ];
    readonly functionPatterns = [
        /function\s+(\w+)\s*\(([^)]*)\)/g,
        /(\w+)\s*:\s*function\s*\(([^)]*)\)/g,
        /(\w+)\s*=\s*function\s*\(([^)]*)\)/g,
        /(\w+)\s*=\s*\(([^)]*)\)\s*=>/g
    ];
    readonly classPatterns = [
        /class\s+(\w+)(?:\s+extends\s+(\w+))?\s*{/g
    ];
    readonly blockPatterns = [
        /{[^{}]*}/g
    ];

    protected parseImport(match: RegExpMatchArray): string {
        return match[1];
    }

    protected parseFunction(match: RegExpMatchArray): { name: string; params: string[]; returnType?: string; } {
        const [_, name, params = ''] = match;
        return {
            name,
            params: params.split(',').map(p => p.trim()).filter(Boolean)
        };
    }

    analyzeDependencies(content: string): string[] {
        const dependencies = new Set<string>();
        try {
            const ast = acorn.parse(content, {
                sourceType: 'module',
                ecmaVersion: 'latest'
            });

            walk.simple(ast, {
                ImportDeclaration(node: any) {
                    dependencies.add(node.source.value);
                },
                CallExpression(node: any) {
                    if (node.callee.name === 'require' && 
                        node.arguments.length > 0 && 
                        node.arguments[0].type === 'Literal') {
                        dependencies.add(node.arguments[0].value);
                    }
                }
            });
        } catch (error) {
            console.error('Error parsing JavaScript:', error);
        }

        return Array.from(dependencies);
    }

    analyzeFunctions(content: string): { name: string; params: string[]; returnType?: string; complexity: number; }[] {
        const functions: { name: string; params: string[]; returnType?: string; complexity: number; }[] = [];
        
        try {
            const ast = acorn.parse(content, {
                sourceType: 'module',
                ecmaVersion: 'latest'
            });

            const calculateComplexity = (node: any): number => {
                let complexity = 1;
                walk.simple(node, {
                    IfStatement: () => complexity++,
                    ForStatement: () => complexity++,
                    WhileStatement: () => complexity++,
                    DoWhileStatement: () => complexity++,
                    SwitchCase: () => complexity++,
                    LogicalExpression: () => complexity++,
                    ConditionalExpression: () => complexity++
                });
                return complexity;
            };

            walk.simple(ast, {
                FunctionDeclaration(node: any) {
                    functions.push({
                        name: node.id.name,
                        params: node.params.map((p: any) => p.name),
                        complexity: calculateComplexity(node)
                    });
                },
                MethodDefinition(node: any) {
                    if (node.value.type === 'FunctionExpression') {
                        functions.push({
                            name: node.key.name,
                            params: node.value.params.map((p: any) => p.name),
                            complexity: calculateComplexity(node.value)
                        });
                    }
                },
                VariableDeclarator(node: any) {
                    if (node.init && 
                        (node.init.type === 'FunctionExpression' || 
                         node.init.type === 'ArrowFunctionExpression')) {
                        functions.push({
                            name: node.id.name,
                            params: node.init.params.map((p: any) => p.name),
                            complexity: calculateComplexity(node.init)
                        });
                    }
                }
            });
        } catch (error) {
            console.error('Error parsing JavaScript:', error);
        }

        return functions;
    }

    analyzeStructure(content: string): { type: 'class' | 'function' | 'interface' | 'variable' | 'other'; name: string; startLine: number; endLine: number; }[] {
        const structures: { type: 'class' | 'function' | 'interface' | 'variable' | 'other'; name: string; startLine: number; endLine: number; }[] = [];
        
        try {
            const ast = acorn.parse(content, {
                sourceType: 'module',
                ecmaVersion: 'latest',
                locations: true
            });

            walk.simple(ast, {
                ClassDeclaration(node: any) {
                    structures.push({
                        type: 'class',
                        name: node.id.name,
                        startLine: node.loc.start.line - 1,
                        endLine: node.loc.end.line - 1
                    });
                },
                FunctionDeclaration(node: any) {
                    structures.push({
                        type: 'function',
                        name: node.id.name,
                        startLine: node.loc.start.line - 1,
                        endLine: node.loc.end.line - 1
                    });
                },
                VariableDeclaration(node: any) {
                    node.declarations.forEach((decl: any) => {
                        structures.push({
                            type: 'variable',
                            name: decl.id.name,
                            startLine: node.loc.start.line - 1,
                            endLine: node.loc.end.line - 1
                        });
                    });
                }
            });
        } catch (error) {
            console.error('Error parsing JavaScript:', error);
        }

        return structures;
    }

    detectSyntaxErrors(content: string): { line: number; column: number; message: string; }[] {
        const errors: { line: number; column: number; message: string; }[] = [];
        
        try {
            acorn.parse(content, {
                sourceType: 'module',
                ecmaVersion: 'latest',
                locations: true,
                onError: (error: Error) => {
                    errors.push({
                        line: (error as any).loc.line - 1,
                        column: (error as any).loc.column,
                        message: error.message
                    });
                }
            } as any);
        } catch (error: any) {
            if (error.loc) {
                errors.push({
                    line: error.loc.line - 1,
                    column: error.loc.column,
                    message: error.message
                });
            }
        }

        return errors;
    }

    generateImports(dependencies: string[]): string {
        return dependencies
            .map(dep => `import ${this.generateImportName(dep)} from '${dep}';`)
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
        const paramsList = params.join(', ');
        return `function ${name}(${paramsList}) {\n${this.indentCode(body)}\n}`;
    }

    generateClass(name: string, properties: string[], methods: string[]): string {
        const props = properties.map(p => `    ${p};`).join('\n');
        const meths = methods.map(m => this.indentCode(m)).join('\n\n');
        return `class ${name} {\n${props}\n\n${meths}\n}`;
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
        try {
            const ast = acorn.parse(content, {
                sourceType: 'module',
                ecmaVersion: 'latest'
            });

            const usedIdentifiers = new Set<string>();
            walk.simple(ast, {
                Identifier(node: any) {
                    usedIdentifiers.add(node.name);
                }
            });

            return imports.every(imp => {
                const importName = this.generateImportName(imp);
                return usedIdentifiers.has(importName);
            });
        } catch (error) {
            return false;
        }
    }

    validateStructure(content: string): boolean {
        try {
            const ast = acorn.parse(content, {
                sourceType: 'module',
                ecmaVersion: 'latest'
            });

            let hasDefaultExport = false;
            let hasNamedExports = false;

            walk.simple(ast, {
                ExportDefaultDeclaration() {
                    hasDefaultExport = true;
                },
                ExportNamedDeclaration() {
                    hasNamedExports = true;
                }
            });

            // Basic structure validation - at least one export
            return hasDefaultExport || hasNamedExports;
        } catch (error) {
            return false;
        }
    }

    formatCode(content: string): string {
        try {
            const ast = acorn.parse(content, {
                sourceType: 'module',
                ecmaVersion: 'latest'
            });

            let formatted = '';
            let indentLevel = 0;

            walk.simple(ast, {
                Program: (node: any) => { indentLevel = 0; },
                BlockStatement: (node: any) => {
                    if (node.type === 'BlockStatement') {
                        indentLevel++;
                    }
                }
            });

            return formatted;
        } catch (error) {
            return content; // Return original if parsing fails
        }
    }

    injectImports(content: string, imports: string[]): string {
        const existingImports = this.analyzeImports(content);
        const newImports = imports.filter(imp => !existingImports.includes(imp));
        
        if (newImports.length === 0) {
            return content;
        }

        const importStatements = this.generateImports(newImports);
        
        try {
            const ast = acorn.parse(content, {
                sourceType: 'module',
                ecmaVersion: 'latest'
            });

            let lastImportIndex = -1;
            walk.simple(ast, {
                ImportDeclaration(node: any) {
                    lastImportIndex = Math.max(lastImportIndex, node.end);
                }
            });

            if (lastImportIndex === -1) {
                return importStatements + '\n\n' + content;
            } else {
                return content.slice(0, lastImportIndex) + '\n' + 
                       importStatements + '\n' + 
                       content.slice(lastImportIndex);
            }
        } catch (error) {
            return importStatements + '\n\n' + content;
        }
    }

    wrapInFunction(content: string, functionName: string): string {
        return `function ${functionName}() {\n${this.indentCode(content)}\n}`;
    }
}
