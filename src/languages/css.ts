import { BaseLanguageHandler } from './base';
import * as cssTree from 'css-tree';

export class CSSHandler extends BaseLanguageHandler {
    readonly fileExtensions = ['.css'];
    readonly languageId = 'css';
    readonly importPatterns = [
        /@import\s+(?:url\s*\()?\s*['"]([^'"]+)['"]\s*\)?/g
    ];
    readonly dependencyPatterns = [
        /package\.json/g,
        /styles\.css/g,
        /global\.css/g
    ];
    readonly functionPatterns = [
        /@mixin\s+(\w+)\s*\(([^)]*)\)/g,
        /@function\s+(\w+)\s*\(([^)]*)\)/g
    ];
    readonly classPatterns = [
        /\.([a-zA-Z][\w-]*)/g
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
            const ast = cssTree.parse(content);
            cssTree.walk(ast, {
                visit: 'Atrule',
                enter: (node: any) => {
                    if (node.name === 'import' || node.name === 'use') {
                        const stringNode = node.prelude.children.first();
                        if (stringNode && stringNode.type === 'String') {
                            dependencies.add(stringNode.value.slice(1, -1));
                        }
                    }
                }
            });
        } catch (error) {
            console.error('Error parsing CSS:', error);
        }

        return Array.from(dependencies);
    }

    analyzeFunctions(content: string): { name: string; params: string[]; returnType?: string; complexity: number; }[] {
        const functions: { name: string; params: string[]; returnType?: string; complexity: number; }[] = [];
        
        try {
            const ast = cssTree.parse(content, {
                context: 'stylesheet'
            });

            cssTree.walk(ast, {
                visit: 'Atrule',
                enter: (node: any) => {
                    if (node.name === 'mixin' || node.name === 'function') {
                        const name = node.prelude.children.first().name;
                        const params = node.prelude.children
                            .filter((child: any) => child.type === 'Declaration')
                            .map((child: any) => child.property);
                        
                        functions.push({
                            name,
                            params,
                            complexity: this.calculateComplexity(node)
                        });
                    }
                }
            });
        } catch (error) {
            console.error('Error parsing CSS:', error);
        }

        return functions;
    }

    private calculateComplexity(node: any): number {
        let complexity = 1;
        
        cssTree.walk(node, {
            visit: 'Rule',
            enter: () => complexity++
        });

        return complexity;
    }

    analyzeStructure(content: string): { type: 'class' | 'function' | 'interface' | 'variable' | 'other'; name: string; startLine: number; endLine: number; }[] {
        const structures: { type: 'class' | 'function' | 'interface' | 'variable' | 'other'; name: string; startLine: number; endLine: number; }[] = [];
        
        try {
            const ast = cssTree.parse(content);
            
            cssTree.walk(ast, {
                visit: 'Rule',
                enter: (node: any) => {
                    if (node.prelude.type === 'SelectorList') {
                        const selector = cssTree.generate(node.prelude);
                        const lines = content.slice(0, node.loc.start.offset).split('\n');
                        const startLine = lines.length - 1;
                        const endLine = content.slice(0, node.loc.end.offset).split('\n').length - 1;
                        
                        structures.push({
                            type: selector.startsWith('.') ? 'class' : 'other',
                            name: selector,
                            startLine,
                            endLine
                        });
                    }
                }
            });
        } catch (error) {
            console.error('Error parsing CSS:', error);
        }

        return structures;
    }

    detectSyntaxErrors(content: string): { line: number; column: number; message: string; }[] {
        const errors: { line: number; column: number; message: string; }[] = [];
        
        try {
            cssTree.parse(content, {
                onParseError: (error: any) => {
                    errors.push({
                        line: error.line - 1,
                        column: error.column - 1,
                        message: error.message
                    });
                }
            });
        } catch (error: any) {
            if (error.line && error.column) {
                errors.push({
                    line: error.line - 1,
                    column: error.column - 1,
                    message: error.message
                });
            }
        }

        return errors;
    }

    generateImports(dependencies: string[]): string {
        return dependencies
            .map(dep => `@import '${dep}';`)
            .join('\n');
    }

    generateFunction(name: string, params: string[], returnType: string, body: string): string {
        const paramsList = params.join(', ');
        return `@mixin ${name}(${paramsList}) {\n${this.indentCode(body)}\n}`;
    }

    generateClass(name: string, properties: string[], methods: string[]): string {
        const props = properties.map(p => `    ${p};`).join('\n');
        return `.${name} {\n${props}\n}`;
    }

    private indentCode(code: string, spaces: number = 4): string {
        return code.split('\n')
            .map(line => ' '.repeat(spaces) + line)
            .join('\n');
    }

    validateSyntax(content: string): boolean {
        try {
            cssTree.parse(content);
            return true;
        } catch (error) {
            return false;
        }
    }

    validateImports(content: string): boolean {
        const imports = this.analyzeImports(content);
        
        // Check if imports are at the top of the file
        const lines = content.split('\n');
        let foundRuleBeforeImport = false;
        
        for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine === '' || trimmedLine.startsWith('/*')) continue;
            
            if (!trimmedLine.startsWith('@import') && !trimmedLine.startsWith('@use')) {
                foundRuleBeforeImport = true;
            } else if (foundRuleBeforeImport) {
                return false;
            }
        }
        
        return true;
    }

    validateStructure(content: string): boolean {
        try {
            const ast = cssTree.parse(content);
            let hasValidStructure = true;
            
            cssTree.walk(ast, {
                visit: 'Rule',
                enter: (node: any) => {
                    // Check for nested selectors (not allowed in standard CSS)
                    if (node.block.children.some((child: any) => child.type === 'Rule')) {
                        hasValidStructure = false;
                    }
                }
            });
            
            return hasValidStructure;
        } catch (error) {
            return false;
        }
    }

    formatCode(content: string): string {
        try {
            const ast = cssTree.parse(content);
            return cssTree.generate(ast, {
                sourceMap: false
            });
        } catch (error) {
            return content;
        }
    }

    injectImports(content: string, imports: string[]): string {
        const existingImports = this.analyzeImports(content);
        const newImports = imports.filter(imp => !existingImports.includes(imp));
        
        if (newImports.length === 0) {
            return content;
        }
        
        const importStatements = this.generateImports(newImports);
        
        // Find the last import statement in the file
        const lines = content.split('\n');
        let lastImportIndex = -1;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith('@import') || line.startsWith('@use')) {
                lastImportIndex = i;
            } else if (line !== '' && !line.startsWith('/*')) {
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
        return `@mixin ${functionName} {\n${this.indentCode(content)}\n}`;
    }
}
