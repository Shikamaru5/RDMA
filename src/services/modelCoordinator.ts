import * as vscode from 'vscode';
import { 
    TaskType, TaskResult, ValidationResult, 
    ModelState, Task, PlanStep, ExecutionPlan, CodeOperation, TaskContext, 
    CommandOperation, CommandResult, CommandValidation, ModelResponse, ModelFileOperation, 
    PlanValidationContext,  
    CodeContext, TaskAnalysis, SymbolReference, CallHierarchyItem, TypeHierarchyItem
} from '../types';
import { OllamaService } from './ollamaService';
import { MemoryService } from './memoryService';
import { CommandService } from './commandService';
import { CodeAnalysisService } from './codeAnalysisService';
import { FileSystemService } from './fileSystemService';
import { LanguageRegistry } from '../languages/registry';
import { LanguageHandler } from '../languages/base';
import { PlanValidatorService } from './planValidatorService';
import { PlanAdaptingService } from './planAdaptingService';
import * as path from 'path';
import * as fs from 'fs';

export class ModelCoordinator {
    private outputChannel: vscode.OutputChannel;
    private modelStates: Map<string, ModelState> = new Map();
    private taskQueue: Task[] = [];
    private currentTask: Task | null = null;
    private currentModel: string;
    private currentPlan: ExecutionPlan | null = null;
    private readonly CHAT_MODEL: string = 'hermes3:8b';
    private readonly CODE_MODEL: string = 'qwen2.5-coder:7b';
    private readonly VISION_MODEL: string = 'llama3.2-vision:11b';
    private memoryService: MemoryService;
    private fileSystemService: FileSystemService;
    private commandService: CommandService;
    private codeAnalysisService: CodeAnalysisService;
    private planValidatorService: PlanValidatorService;
    private planAdaptingService: PlanAdaptingService;
    private languageRegistry: LanguageRegistry;
    private lastAnalyzedSymbol?: string;
    private lastAnalyzedFunction?: string;
    private lastAnalyzedType?: string;

    constructor(
        private readonly ollamaService: OllamaService,
        context: vscode.ExtensionContext
    ) {
        this.outputChannel = vscode.window.createOutputChannel('Model Coordinator');
        this.currentModel = this.CHAT_MODEL;
        this.memoryService = new MemoryService(context);
        this.fileSystemService = new FileSystemService();
        this.commandService = new CommandService(this);
        this.codeAnalysisService = new CodeAnalysisService(this.fileSystemService);
        this.planAdaptingService = new PlanAdaptingService(
            this.memoryService,
            this.codeAnalysisService
        );
        // Initialize without ModelCoordinator first
        this.planValidatorService = new PlanValidatorService(
            this.memoryService,
            this.codeAnalysisService,
            this.fileSystemService,
            this.ollamaService,
            this  // Pass 'this' as ModelCoordinator
        );
        this.initializeModelStates();
        this.languageRegistry = LanguageRegistry.getInstance();
    }

    private initializeModelStates() {
        const initialState: ModelState = {
            isRunning: false,
            lastUsed: new Date(),
            performance: {
                avgResponseTime: 0,
                errorRate: 0,
                successfulTasks: 0,
                failedTasks: 0
            }
        };

        [this.CHAT_MODEL, this.CODE_MODEL, this.VISION_MODEL].forEach(model => {
            this.modelStates.set(model, { ...initialState });
        });
    }

    private async getCodeContext(filePath?: string, symbolName?: string): Promise<CodeContext | undefined> {
        // Get base context
        if (!filePath) {
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor) {
                return undefined;
            }
            filePath = activeEditor.document.uri.fsPath;
        }

        const handler = this.languageRegistry.getHandlerForFile(filePath);
        if (!handler) return undefined;

        const analysis = await this.fileSystemService.analyzeFile(filePath);
        if (!analysis.content || !analysis.languageAnalysis) return undefined;

        const baseContext: CodeContext = {
            filePath,
            language: handler.languageId,
            imports: analysis.languageAnalysis.imports,
            dependencies: analysis.languageAnalysis.dependencies,
            structure: analysis.languageAnalysis.structure
        };

        // Add symbol references
        if (symbolName) {
            const references = await this.codeAnalysisService.findSymbolReferences(symbolName);
            if (references.length > 0) {
                this.lastAnalyzedSymbol = symbolName;
                baseContext.symbolReferences = references.map(ref => ({
                    name: ref.symbol,
                    kind: vscode.SymbolKind.Variable,
                    location: new vscode.Location(
                        vscode.Uri.file(ref.location.filePath),
                        new vscode.Range(
                            ref.location.range.startLine,     // Changed from ref.location.line
                            ref.location.range.startColumn,   // Changed from ref.location.column
                            ref.location.range.endLine,
                            ref.location.range.endColumn
                        )
                    )
                }));
            }
    
            // Add call hierarchy for functions
            if (this.looksLikeFunction(symbolName)) {
                const callHierarchy = await this.codeAnalysisService.buildCallHierarchy(symbolName);
                if (callHierarchy) {
                    this.lastAnalyzedFunction = symbolName;
                    baseContext.callHierarchy = {
                        name: callHierarchy.symbol,
                        kind: vscode.SymbolKind.Function,
                        uri: vscode.Uri.file(callHierarchy.location.filePath),
                        range: new vscode.Range(
                            callHierarchy.location.range.startLine,
                            callHierarchy.location.range.startColumn,
                            callHierarchy.location.range.endLine,
                            callHierarchy.location.range.endColumn
                        ),
                        selectionRange: new vscode.Range(
                            callHierarchy.location.range.startLine,
                            callHierarchy.location.range.startColumn,
                            callHierarchy.location.range.endLine,
                            callHierarchy.location.range.endColumn
                        )
                    };
                }
            }
        }

        // Add type hierarchy for types
        if (symbolName && this.looksLikeType(symbolName)) {
            const typeHierarchy = await this.codeAnalysisService.buildTypeHierarchy(symbolName);
            if (typeHierarchy) {
                this.lastAnalyzedType = symbolName;
                baseContext.typeHierarchy = {
                    name: typeHierarchy.symbol,
                    kind: vscode.SymbolKind.Class,
                    uri: vscode.Uri.file(typeHierarchy.location.filePath),
                    range: new vscode.Range(
                        typeHierarchy.location.range.startLine,
                        typeHierarchy.location.range.startColumn,
                        typeHierarchy.location.range.endLine,
                        typeHierarchy.location.range.endColumn
                    ),
                    selectionRange: new vscode.Range(
                        typeHierarchy.location.range.startLine,
                        typeHierarchy.location.range.startColumn,
                        typeHierarchy.location.range.endLine,
                        typeHierarchy.location.range.endColumn
                    )
                };
            }
        }

        return baseContext;
    }

    // Add new method for code navigation
    private async analyzeCodeContext(input: string): Promise<TaskContext> {
        const context = await this.analyzeTask(input);
    
        if (context.type === 'code' || context.type === 'codeAnalysis') {
            // Extract potential symbols from the input
            const symbols = this.extractSymbolsFromInput(input);
    
            for (const symbol of symbols) {
                // Find symbol references
                const references = await this.codeAnalysisService.findSymbolReferences(symbol);
                if (references.length > 0) {
                    this.lastAnalyzedSymbol = symbol;
                    if (!context.codeContext) {
                        context.codeContext = {} as CodeContext;
                    }
                    context.codeContext.symbolReferences = references.map(ref => ({
                        name: ref.symbol,
                        kind: vscode.SymbolKind.Variable,
                        location: {
                            uri: vscode.Uri.file(ref.location.filePath),
                            range: new vscode.Range(
                                ref.location.range.startLine,
                                ref.location.range.startColumn,
                                ref.location.range.endLine,
                                ref.location.range.endColumn
                            )
                        }
                    }));
                }
    
                // Try to build call hierarchy if it looks like a function
                if (this.looksLikeFunction(symbol)) {
                    const callHierarchy = await this.codeAnalysisService.buildCallHierarchy(symbol);
                    if (callHierarchy) {
                        this.lastAnalyzedFunction = symbol;
                        if (!context.codeContext) {
                            context.codeContext = {} as CodeContext;
                        }
                        context.codeContext.callHierarchy = {
                            name: callHierarchy.symbol,
                            kind: vscode.SymbolKind.Function,
                            uri: vscode.Uri.file(callHierarchy.location.filePath),
                            range: new vscode.Range(
                                callHierarchy.location.range.startLine,
                                callHierarchy.location.range.startColumn,
                                callHierarchy.location.range.endLine,
                                callHierarchy.location.range.endColumn
                            ),
                            selectionRange: new vscode.Range(
                                callHierarchy.location.range.startLine,
                                callHierarchy.location.range.startColumn,
                                callHierarchy.location.range.endLine,
                                callHierarchy.location.range.endColumn
                            )
                        };
                    }
                }
    
                // Try to build type hierarchy if it looks like a type
                if (this.looksLikeType(symbol)) {
                    const typeHierarchy = await this.codeAnalysisService.buildTypeHierarchy(symbol);
                    if (typeHierarchy) {
                        this.lastAnalyzedType = symbol;
                        if (!context.codeContext) {
                            context.codeContext = {} as CodeContext;
                        }
                        context.codeContext.typeHierarchy = {
                            name: typeHierarchy.symbol,
                            kind: vscode.SymbolKind.Class,
                            uri: vscode.Uri.file(typeHierarchy.location.filePath),
                            range: new vscode.Range(
                                typeHierarchy.location.range.startLine,
                                typeHierarchy.location.range.startColumn,
                                typeHierarchy.location.range.endLine,
                                typeHierarchy.location.range.endColumn
                            ),
                            selectionRange: new vscode.Range(
                                typeHierarchy.location.range.startLine,
                                typeHierarchy.location.range.startColumn,
                                typeHierarchy.location.range.endLine,
                                typeHierarchy.location.range.endColumn
                            )
                        };
                    }
                }
            }
        }
    
        return context; // Ensure the method always returns a value
        
    }

    private extractSymbolsFromInput(input: string): string[] {
        // Extract potential symbols using regex
        const symbolRegex = /[A-Z][a-zA-Z0-9]*|[a-z][a-zA-Z0-9]*/g;
        const matches = input.match(symbolRegex) || [];
        return [...new Set(matches)];
    }

    private looksLikeFunction(symbol: string): boolean {
        // Check if symbol follows function naming conventions
        return /^[a-z][a-zA-Z0-9]*$/.test(symbol) && 
               !symbol.includes('Type') && 
               !symbol.includes('Interface') && 
               !symbol.includes('Class');
    }

    private looksLikeType(symbol: string): boolean {
        // Check if symbol follows type naming conventions
        return /^[A-Z][a-zA-Z0-9]*$/.test(symbol) || 
               symbol.includes('Type') || 
               symbol.includes('Interface') || 
               symbol.includes('Class');
    }

    private async validateCodeChange(
        filePath: string,
        newContent: string,
        context: CodeContext
    ): Promise<ValidationResult> {
        const handler = this.languageRegistry.getHandlerForFile(filePath);
        if (!handler) {
            return { isValid: false, errors: ['No language handler available'] };
        }

        // Get type checking results for TypeScript files
        if (handler.languageId === 'typescript') {
            const typeCheck = await this.fileSystemService.codeAnalysis.checkTypes(filePath);
            if (!typeCheck.isValid) {
                return { 
                    isValid: false, 
                    errors: typeCheck.errors.map(e => e.message)
                };
            }
        }

        // Syntax validation
        const syntaxErrors = handler.detectSyntaxErrors(newContent);
        if (syntaxErrors.length > 0) {
            return { 
                isValid: false, 
                errors: syntaxErrors.map(diagnostic => 
                    `Line ${diagnostic.line}: ${diagnostic.message}`
                )
            };
        }

        // Impact analysis
        const impactedFiles = await this.fileSystemService.codeAnalysis.getImpactedFiles(filePath);
        if (impactedFiles.length > 0) {
            // Validate each impacted file
            for (const impactedFile of impactedFiles) {
                const impactedHandler = this.languageRegistry.getHandlerForFile(impactedFile);
                if (impactedHandler) {
                    const impactedContent = await fs.promises.readFile(impactedFile, 'utf-8');
                    const impactedErrors = impactedHandler.detectSyntaxErrors(impactedContent);
                    if (impactedErrors.length > 0) {
                        return {
                            isValid: false,
                            errors: [`Changes would break ${path.basename(impactedFile)}`]
                        };
                    }
                }
            }
        }

        return { 
            isValid: true,
            impactedFiles  // Return impacted files for reference
        };
    }

    private async prepareCodePrompt(input: string, context: CodeContext): Promise<string> {
        // Get impact analysis
        const impactedFiles = context.impactedFiles || [];
        const impactWarning = impactedFiles.length > 0 
            ? `\nWarning: Changes may impact these files:\n${impactedFiles.map(f => `- ${path.basename(f)}`).join('\n')}`
            : '';

        // Get any existing errors
        const existingErrors = context.syntaxErrors || [];
        const errorContext = existingErrors.length > 0
            ? `\nExisting Issues to Fix:\n${existingErrors.map(e => `- Line ${e.range.start.line + 1}: ${e.message}`).join('\n')}`
            : '';

        // Enhance the prompt with language-specific context
        return `
Language: ${context.language}
Current Imports: ${context.imports.join(', ')}
Current Structure:
${JSON.stringify(context.structure, null, 2)}
${errorContext}
${impactWarning}

Task: ${input}

Provide code that:
1. Maintains consistent style with existing code
2. Handles imports correctly
3. Follows language-specific best practices
4. Integrates with existing code structure
5. Fixes any existing issues
6. Considers impact on related files
`;
    }

    public async delegateTask(task: Omit<Task, 'id'>): Promise<TaskResult> {
        const taskId = Math.random().toString(36).substring(7);
        const fullTask: Task = { ...task, id: taskId };

        try {
            // 1. Analyze task using Hermes3
            const analysis = await this.analyzeTask(task.prompt);
            
            // 2. Create validation context
            const recentContext = await this.memoryService.getRecentContext();
            const validationContext: PlanValidationContext = {
                objective: this.currentPlan?.objective || task.objective,
                currentStep: {
                    id: taskId,
                    type: this.mapTaskTypeToPlanStepType(this.mapContextTypeToTaskType(analysis.type)),
                    description: task.prompt,
                    requiresModel: analysis.targetModel,
                    status: 'pending'
                },
                previousSteps: this.currentPlan?.steps.slice(0, this.currentPlan.currentStepIndex) || [],
                memory: {
                    codeChanges: recentContext.fileChanges.map(fc => ({ 
                        path: fc.path, 
                        diff: fc.diff 
                    })),
                    analysisResults: recentContext.codeAnalysis.map(ca => ({
                        path: ca.path,
                        analysis: ca.analysis
                    })),
                    errors: recentContext.codeAnalysis
                        .filter(ca => ca.errors)
                        .flatMap(ca => ca.errors || [])
                },
                prompt: task.prompt
            };

            // 3. Pre-execution validation
            const preValidation = await this.planValidatorService.validatePlanStep(validationContext);
            if (!preValidation.isValid) {
                if (preValidation.requiresPlanRevision && this.currentPlan) {
                    await this.handlePlanRevision(preValidation.suggestedRevisions || []);
                }
                return {
                    success: false,
                    error: preValidation.errors?.join(', '),
                    data: null,
                    modelUsed: this.currentModel
                };
            }

            // 4. Determine if model switch is needed
            if (analysis.requiresModelSwitch) {
                const targetModel = analysis.targetModel;
                if (!(await this.switchModel(targetModel))) {
                    throw new Error(`Failed to switch to required model: ${targetModel}`);
                }
            }

            // 5. Execute task with proper context
            const result = await this.executeTask({
                ...fullTask,
                type: this.mapContextTypeToTaskType(analysis.type),
                requiresModelSwitch: analysis.requiresModelSwitch
            });

            // 6. Post-execution validation
            if (analysis.validationRequired) {
                const postValidation = await this.planValidatorService.validatePlanStep({
                    ...validationContext,
                    executionResult: result
                });

                if (!postValidation.isValid) {
                    if (postValidation.requiresPlanRevision && this.currentPlan) {
                        await this.handlePlanRevision(postValidation.suggestedRevisions || []);
                    }
                    return {
                        success: false,
                        error: postValidation.errors?.join(', '),
                        data: result.data,
                        modelUsed: this.currentModel,
                        analysis: {
                            taskType: analysis.type,
                            requiresSpecialist: analysis.requiresModelSwitch,
                            targetModel: analysis.targetModel,
                            complexity: this.estimateComplexity(task.prompt),
                            validationErrors: postValidation.errors
                        }
                    };
                }
            }

            return {
                success: true,
                data: result,
                modelUsed: this.currentModel,
                analysis: {
                    taskType: analysis.type,
                    requiresSpecialist: analysis.requiresModelSwitch,
                    targetModel: analysis.targetModel,
                    complexity: this.estimateComplexity(task.prompt)
                }
            };

        } catch (error: any) {
            return {
                success: false,
                error: error.message,
                data: null,
                modelUsed: this.currentModel
            };
        }
    }

    private mapContextTypeToTaskType(contextType: string): TaskType {
        // Normalize task types to our simplified set
        switch (contextType) {
            case 'code':
            case 'codeAnalysis':
                return 'code';
            case 'image':
            case 'vision':
                return 'image';
            case 'chat':
            case 'analysis':
            case 'validation':
            case 'general':
            default:
                return 'general';
        }
    }

    private mapTaskTypeToPlanStepType(taskType: TaskType): PlanStep['type'] {
        switch (taskType) {
            case 'code':
                return 'code';
            case 'codeAnalysis':
                return 'analysis';
            case 'image':
            case 'general':
                return 'general';
            default:
                return 'general';
        }
    }
    
    private async analyzeTask(input: string): Promise<TaskContext> {
        try {
            const taskFeatures = {
                requiresCode: this.hasCodeRelatedKeywords(input),
                requiresVision: this.hasImageRelatedKeywords(input),
                complexityEstimate: this.estimateComplexity(input)
            };

            // Determine task type and model
            let taskType: TaskType = 'general';
            let targetModel = this.CHAT_MODEL;
            let requiresSpecialist = false;

            if (taskFeatures.requiresCode) {
                taskType = taskFeatures.complexityEstimate > 4 ? 'codeAnalysis' : 'code';
                targetModel = this.CODE_MODEL;
                requiresSpecialist = true;
            } else if (taskFeatures.requiresVision) {
                taskType = 'image';
                targetModel = this.VISION_MODEL;
                requiresSpecialist = true;
            }

            // High complexity code tasks should always use the code model
            if (taskFeatures.complexityEstimate >= 5 && taskType === 'code') {
                targetModel = this.CODE_MODEL;
                requiresSpecialist = true;
            }

            return {
                type: taskType,
                requiresModelSwitch: requiresSpecialist,
                targetModel: targetModel,
                validationRequired: taskFeatures.complexityEstimate > 7,
                plan: undefined,
                execution: undefined,
                codeContext: taskType === 'code' ? await this.getCodeContext() : undefined
            };
        } catch (error) {
            this.outputChannel.appendLine(`Task analysis failed: ${error}`);
            // Default to general task if analysis fails
            return {
                type: 'general',
                requiresModelSwitch: false,
                targetModel: this.CHAT_MODEL,
                validationRequired: false,
                plan: undefined,
                execution: undefined
            };
        }
    }

    private determineTargetModel(features: { 
        requiresCode: boolean; 
        requiresVision: boolean; 
        complexityEstimate: number 
    }): string {
        if (features.requiresVision) {
            return this.VISION_MODEL;
        }
        if (features.requiresCode || features.complexityEstimate > 7) {
            return this.CODE_MODEL;
        }
        return this.CHAT_MODEL;
    }

    private hasCodeRelatedKeywords(input: string): boolean {
        const codeKeywords = [
            // Programming languages
            'python', 'javascript', 'typescript', 'java', 'c++', 'rust', 'go',
            'ruby', 'php', 'swift', 'kotlin', 'scala', 'r', 'matlab',
            
            // Programming concepts
            'code', 'function', 'class', 'method', 'variable', 'api',
            'debug', 'error', 'compile', 'runtime', 'syntax', 'algorithm',
            'implement', 'refactor', 'optimize', 'test', 'lint', 'build',
            'interface', 'module', 'package', 'library', 'framework',
            'async', 'await', 'promise', 'callback', 'event', 'handler',
            
            // Development tasks
            'create file', 'new file', 'script', 'program', 'application',
            'project', 'repository', 'git', 'version', 'dependency',
            'import', 'export', 'install', 'setup', 'configure',
            
            // File operations
            'create directory', 'make directory', 'mkdir', 'create folder',
            'make folder', 'new folder', 'new directory'
        ];

        const lowercaseInput = input.toLowerCase();
        return codeKeywords.some(keyword => lowercaseInput.includes(keyword.toLowerCase()));
    }

    private hasImageRelatedKeywords(input: string): boolean {
        const imageKeywords = [
            'image', 'picture', 'photo', 'visualization',
            'diagram', 'graph', 'plot', 'visual', 'display'
        ];
        const lowercaseInput = input.toLowerCase();
        return imageKeywords.some(keyword => lowercaseInput.includes(keyword.toLowerCase()));
    }

    private estimateComplexity(input: string): number {
        let complexity = 1;
        const lowercaseInput = input.toLowerCase();
        
        // Length-based complexity
        complexity += Math.min(3, Math.floor(input.length / 100));
        
        // Task scope complexity
        if (lowercaseInput.includes('game') || 
            lowercaseInput.includes('application') || 
            lowercaseInput.includes('system')) {
            complexity += 3;
        }
        
        // Implementation complexity
        if (lowercaseInput.includes('full') || 
            lowercaseInput.includes('complete') ||
            lowercaseInput.includes('comprehensive')) {
            complexity += 2;
        }
        
        // Technical complexity
        const complexityKeywords = [
            'optimize', 'refactor', 'architecture', 'async',
            'concurrent', 'parallel', 'distributed', 'scale',
            'security', 'encryption', 'authentication',
            'database', 'api', 'integration', 'deploy'
        ];
        
        complexity += complexityKeywords.reduce((acc, keyword) => 
            acc + (lowercaseInput.includes(keyword) ? 1 : 0), 0
        );

        // Framework/library complexity
        const frameworkKeywords = [
            'react', 'angular', 'vue', 'django', 'flask',
            'spring', 'express', 'tensorflow', 'pytorch'
        ];
        
        if (frameworkKeywords.some(fw => lowercaseInput.includes(fw))) {
            complexity += 2;
        }

        return Math.min(10, complexity);
    }

    private async transformResponse(response: any): Promise<string> {
        if (typeof response === 'string') {
            try {
                // Attempt to parse and format as JSON
                const parsed = JSON.parse(response);
                return JSON.stringify(parsed, null, 2);
            } catch {
                // If not valid JSON, ensure it's properly structured
                return this.formatChunkedResponse(response);
            }
        }
        return JSON.stringify(response, null, 2);
    }

    private formatChunkedResponse(response: string): string {
        // Convert chunked response into proper JSON structure
        const lines = response.split('\n').filter(line => line.trim());
        
        return JSON.stringify({
            analysis: {
                taskType: this.inferTaskType(lines),
                complexity: 'medium',
                requiresSpecialist: false,
                targetModel: this.CHAT_MODEL,
                reasoning: 'Inferred from chunked response'
            },
            plan: {
                steps: lines,
                requiresModelSwitch: false,
                expectedOutputs: ['Formatted response']
            },
            execution: {
                currentStep: 1,
                remainingSteps: 0,
                status: 'complete'
            },
            response: {
                content: lines.join('\n'),
                requiresValidation: false,
                nextAction: 'None'
            }
        }, null, 2);
    }

    private inferTaskType(lines: string[]): 'code' | 'image' | 'general' {
        const content = lines.join(' ').toLowerCase();
        if (this.hasCodeRelatedKeywords(content)) return 'code';
        if (this.hasImageRelatedKeywords(content)) return 'image';
        return 'general';
    }

    private async processNextTask(): Promise<void> {
        if (this.taskQueue.length === 0 || this.currentTask) return;

        this.currentTask = this.taskQueue.shift()!;
        try {
            const result = await this.executeTask(this.currentTask);
            if (this.currentTask.callback) {
                this.currentTask.callback(result);
            }
        } catch (error: any) {
            this.outputChannel.appendLine(`Task execution failed: ${error}`);
            if (this.currentTask.callback) {
                this.currentTask.callback({
                    success: false,
                    error: error.message,
                    data: null,
                    modelUsed: this.currentModel
                });
            }
        } finally {
            this.currentTask = null;
            this.processNextTask();
        }
    }

    private async executeTask(task: Task): Promise<TaskResult> {
        try {
            // If this is already a delegated task (from Hermes3's plan), execute directly
            if (task.isDelegated) {
                return await this.executeDelegatedTask(task);
            }
    
            // Get enhanced context with both code structure and symbol analysis
            const context = await this.analyzeCodeContext(task.prompt);
            
            // If we have a file context, enhance it with code analysis
            if (task.codeContext?.filePath) {
                const enhancedContext = await this.getCodeContext(task.codeContext.filePath);
                task.codeContext = {
                    ...task.codeContext,
                    ...enhancedContext
                };
            }
    
            // If no specialist model is needed, execute directly with Hermes3
            if (!context.requiresModelSwitch) {
                const result = await this.ollamaService.executeTask(task);
                return this.enrichTaskResult(result, context);
            }
    
            // For tasks requiring specialists, execute each step in the plan
            if (context.plan && context.plan.steps) {
                let finalResult: any = null;
                
                for (const step of context.plan.steps) {
                    const stepTask: Task = {
                        ...task,
                        id: `${task.id}_${Math.random().toString(36).substring(7)}`,
                        prompt: step.description,
                        objective: step.description,
                        isDelegated: true,
                        type: step.type as TaskType,
                        requiresModelSwitch: true,
                        callback: task.callback,
                        codeContext: task.codeContext // Preserve the enhanced context
                    };
    
                    // Switch to the appropriate model for this step
                    if (!(await this.switchModel(step.requiresModel))) {
                        throw new Error(`Failed to switch to required model: ${step.requiresModel}`);
                    }
    
                    // Execute the step
                    const stepResult = await this.executeDelegatedTask(stepTask);
                    if (!stepResult.success) {
                        throw new Error(`Step execution failed: ${stepResult.error}`);
                    }
    
                    // Store the result
                    finalResult = stepResult.data;
                }
    
                return this.enrichTaskResult({
                    success: true,
                    data: finalResult,
                    modelUsed: this.currentModel,
                    analysis: {
                        taskType: this.mapContextTypeToTaskType(context.type),
                        requiresSpecialist: context.requiresModelSwitch,
                        targetModel: context.targetModel,
                        complexity: 1,
                        codeNavigation: {
                            analyzedSymbol: this.lastAnalyzedSymbol,
                            analyzedFunction: this.lastAnalyzedFunction,
                            analyzedType: this.lastAnalyzedType,
                            references: context.codeContext?.symbolReferences,
                            callHierarchy: context.codeContext?.callHierarchy,
                            typeHierarchy: context.codeContext?.typeHierarchy
                        }
                    },
                    plan: context.plan,
                    execution: context.execution
                }, context);
            }

            // If we reach here without a plan, return a basic error result
            return {
                success: false,
                error: 'No execution plan available for the task',
                modelUsed: this.currentModel,
                data: null
            };
        } catch (error: any) {
            this.outputChannel.appendLine(`Task execution failed: ${error}`);
            return {
                success: false,
                error: error.message || 'Task execution failed',
                modelUsed: this.currentModel,
                data: null
            };
        }
    }
    
    private enrichTaskResult(result: TaskResult, context: TaskContext): TaskResult {
        try {
            // Add navigation information to the result if available
            if (context.codeContext?.symbolReferences || 
                context.codeContext?.callHierarchy || 
                context.codeContext?.typeHierarchy) {
                result.analysis = {
                    taskType: context.type,
                    requiresSpecialist: false,  // Set appropriate value based on your logic
                    targetModel: context.targetModel,
                    complexity: 0,  // Set appropriate value based on your logic
                    ...result.analysis,
                    codeNavigation: {
                        analyzedSymbol: this.lastAnalyzedSymbol,
                        analyzedFunction: this.lastAnalyzedFunction,
                        analyzedType: this.lastAnalyzedType,
                        references: context.codeContext.symbolReferences,
                        callHierarchy: context.codeContext.callHierarchy,
                        typeHierarchy: context.codeContext.typeHierarchy
                    }
                };
            }
        } catch (error) {
            this.outputChannel.appendLine(`Error enriching task result: ${error instanceof Error ? error.message : String(error)}`);
        }
        return result;
    }

    private async executeDelegatedTask(task: Task): Promise<TaskResult> {
        try {
            const result = await this.ollamaService.executeTask(task);
            
            return {
                success: true,
                data: result.data,
                modelUsed: this.currentModel
            };
        } catch (error: any) {
            return {
                success: false,
                error: error.message,
                data: null,
                modelUsed: this.currentModel
            };
        }
    }

    private async validateTask(task: Task): Promise<ValidationResult> {
        const targetModel = this.getTargetModel(task.type);
        
        try {
            const modelState = this.modelStates.get(targetModel);
            
            // If model isn't running, try to switch to it
            if (!modelState?.isRunning) {
                await this.switchModel(targetModel);
            }

            return { isValid: true };
        } catch (error: any) {
            return {
                isValid: false,
                errors: [`Failed to ensure model ${targetModel} is ready: ${error.message}`]
            };
        }
    }

    private getTargetModel(taskType: TaskType): string {
        switch (taskType) {
            case 'code':
            case 'codeAnalysis':
                return this.CODE_MODEL;
            case 'image':
                return this.VISION_MODEL;
            default:
                return this.CHAT_MODEL;
        }
    }

    private async switchModel(targetModel: string): Promise<boolean> {
        try {
            if (this.currentModel === targetModel) {
                const state = this.modelStates.get(targetModel);
                if (state?.isRunning) {
                    return true;
                }
            }
            
            this.outputChannel.appendLine(`Switching to model: ${targetModel}`);
            await this.ollamaService.switchModel(targetModel);
            this.currentModel = targetModel;
            
            return true;
        } catch (error) {
            this.outputChannel.appendLine(`Model switch error: ${error}`);
            return false;
        }
    }

    public async executeModelResponse(response: ModelResponse): Promise<{ success: boolean; results: string[] }> {
        const results: string[] = [];
        let success = true;

        try {
            for (const operation of response.operations) {
                try {
                    let result: string;
                    if (this.isFileOperation(operation)) {
                        result = await this.executeFileOperation(operation);
                    } else {
                        const task: Task = {
                            id: 'command_' + Date.now(),
                            type: 'command',
                            prompt: '',
                            objective: operation.command,
                            requiresModelSwitch: false,
                            callback: () => {},
                            commandOperation: operation as CommandOperation
                        };
                        const taskResult = await this.executeCommandTask(task);
                        result = taskResult.data;
                    }
                    results.push(result);
                } catch (error) {
                    success = false;
                    results.push(`Failed to execute ${operation.type} operation: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        } catch (error) {
            success = false;
            results.push(`Error executing operations: ${error instanceof Error ? error.message : String(error)}`);
        }

        return { success, results };
    }

    private isFileOperation(operation: ModelFileOperation | CommandOperation): operation is ModelFileOperation {
        return ['create', 'edit', 'delete', 'createDirectory'].includes(operation.type as string);
    }

    private async executeFileOperation(operation: ModelFileOperation): Promise<string> {
        const context = this.fileSystemService.getWorkspaceContext();
        if (!context) {
            throw new Error('No workspace found');
        }

        switch (operation.type) {
            case 'create': {
                if (!operation.filePath && !operation.targetDirectory) {
                    throw new Error('File path or target directory required for create operation');
                }

                let fullPath = operation.filePath;
                if (!fullPath && operation.targetDirectory) {
                    // Analyze workspace to determine best location
                    const analysis = await this.fileSystemService.analyzeWorkspaceForFile(operation.targetDirectory);
                    fullPath = analysis.suggestedLocation;
                }

                if (!fullPath) {
                    throw new Error('Could not determine file path');
                }

                // Resolve path
                fullPath = path.isAbsolute(fullPath) 
                    ? fullPath 
                    : path.join(context.workspacePath, fullPath);

                // Format content based on language
                let content = operation.content || '';
                if (operation.language) {
                    const handler = this.languageRegistry.getHandlerForLanguageId(operation.language);
                    if (handler) {
                        content = await handler.formatCode(content);
                    }
                }

                // Propose the file creation through code analysis service
                const createProposal = await this.codeAnalysisService.proposeChanges(
                    fullPath,
                    [{
                        type: 'addition',
                        startLine: 0,
                        endLine: 0,
                        newContent: content
                    }]
                );

                // If proposal is accepted, create the file
                await this.codeAnalysisService.acceptProposal(fullPath);
                return `Created file: ${operation.filePath}`;
            }
            case 'edit': {
                if (!operation.filePath) {
                    throw new Error('File path required for edit operation');
                }

                if (!operation.edits || operation.edits.length === 0) {
                    throw new Error('No edits specified');
                }

                // Try different path resolutions
                let fullPath = path.isAbsolute(operation.filePath)
                    ? operation.filePath
                    : path.join(context.workspacePath, operation.filePath);

                // If file doesn't exist at the direct path, try test_ollama directory
                if (!fs.existsSync(fullPath)) {
                    throw new Error(`File not found: ${fullPath}`);
                }

                // Analyze the file before making edits
                const fileAnalysis = await this.fileSystemService.analyzeFile(fullPath);
                if (!fileAnalysis.exists) {
                    throw new Error(`File not found: ${fullPath}`);
                }

                if (!fileAnalysis.permissions?.writable) {
                    throw new Error(`File is not writable: ${fullPath}`);
                }

                if (!fileAnalysis.content) {
                    throw new Error(`Unable to read file content: ${fullPath}`);
                }

                // Get current file content and validate line numbers
                const currentLines = fileAnalysis.content.split('\n');
                const maxLine = currentLines.length - 1;

                // Validate all edits before applying any
                for (const edit of operation.edits) {
                    if (edit.startLine < 0 || edit.startLine > maxLine) {
                        throw new Error(`Invalid start line ${edit.startLine}. File has ${currentLines.length} lines`);
                    }
                    if (edit.endLine < edit.startLine || edit.endLine > maxLine) {
                        throw new Error(`Invalid end line ${edit.endLine}. File has ${currentLines.length} lines`);
                    }
                }

                // Convert edits to CodeDiff format
                const diffs = operation.edits.map(edit => ({
                    type: 'modification' as const,
                    startLine: edit.startLine,
                    endLine: edit.endLine,
                    oldContent: currentLines.slice(edit.startLine, edit.endLine + 1).join('\n'),
                    newContent: edit.newContent
                }));

                // Propose changes through code analysis service
                const editProposal = await this.codeAnalysisService.proposeChanges(
                    fullPath,
                    diffs
                );

                // If we have language analysis, validate the new content
                if (fileAnalysis.languageAnalysis) {
                    const handler = this.languageRegistry.getHandlerForLanguageId(fileAnalysis.languageAnalysis.language);
                    if (handler) {
                        const newContent = this.applyEdits(currentLines, operation.edits);
                        const syntaxErrors = handler.detectSyntaxErrors(newContent);
                        if (syntaxErrors.length > 0) {
                            await this.codeAnalysisService.rejectProposal(fullPath, 
                                `Syntax errors in edited content: ${syntaxErrors.map(e => e.message).join(', ')}`
                            );
                            throw new Error(`Syntax errors in edited content: ${syntaxErrors.map(e => e.message).join(', ')}`);
                        }
                    }
                }

                // If proposal is accepted and validation passes, apply the changes
                await this.codeAnalysisService.acceptProposal(fullPath);
                return `Successfully edited file: ${operation.filePath}`;
            }
            case 'delete': {
                if (!operation.filePath) {
                    throw new Error('File path required for delete operation');
                }

                const fullPath = path.isAbsolute(operation.filePath)
                    ? operation.filePath
                    : path.join(context.workspacePath, operation.filePath);

                await fs.promises.unlink(fullPath);
                return `Deleted file: ${operation.filePath}`;
            }
            case 'createDirectory': {
                if (!operation.targetDirectory) {
                    throw new Error('Target directory required for create directory operation');
                }

                const fullPath = path.isAbsolute(operation.targetDirectory)
                    ? operation.targetDirectory
                    : path.join(context.workspacePath, operation.targetDirectory);

                await this.fileSystemService.createDirectory(fullPath);
                return `Created directory: ${operation.targetDirectory}`;
            }
            default: {
                throw new Error(`Unsupported operation type: ${(operation as any).type}`);
            }
        }
    }

    private applyEdits(lines: string[], edits: Array<{ startLine: number; endLine: number; newContent: string; }>): string {
        const newLines = [...lines];
        const sortedEdits = [...edits].sort((a, b) => b.startLine - a.startLine);
        
        for (const edit of sortedEdits) {
            newLines.splice(
                edit.startLine, 
                edit.endLine - edit.startLine + 1,
                edit.newContent
            );
        }
        
        return newLines.join('\n');
    }

    getModelState(model: string): ModelState | undefined {
        return this.modelStates.get(model);
    }

    getCurrentModel(): string {
        return this.currentModel;
    }

    async createExecutionPlan(objective: string): Promise<ExecutionPlan> {
        // Ensure we're using Hermes3 for planning
        if (this.currentModel !== this.CHAT_MODEL) {
            await this.switchModel(this.CHAT_MODEL);
        }

        // Ask Hermes3 to create a plan
        const planTask: Task = {
            id: Math.random().toString(36).substring(7),
            type: 'general',
            prompt: `Create a detailed execution plan for the following objective: ${objective}. 
                    Break it down into steps, specifying which steps require code operations.`,
            objective: 'Create execution plan',
            requiresModelSwitch: false,
            callback: () => {}
        };

        const planResult = await this.ollamaService.executeTask(planTask);

        // Convert the result into a structured plan
        const plan: ExecutionPlan = {
            id: `plan_${Date.now()}_${Math.random().toString(36).substring(7)}`, // Add unique id
            objective,
            steps: this.parsePlanSteps(planResult.data),
            currentStepIndex: 0,
            modelSwitchRequired: false,
            status: 'planning'
        };

        this.currentPlan = plan;
        return plan;
    }

    private parsePlanSteps(planData: any): PlanStep[] {
        // Implementation will depend on how Hermes3 structures its response
        // This is a simplified version
        return planData.steps.map((step: any, index: number) => ({
            id: `step_${index}`,
            description: step.description,
            type: this.determineStepType(step.description),
            requiresModel: this.determineRequiredModel(step.description),
            dependencies: [],
            status: 'pending'
        }));
    }

    private determineStepType(description: string): PlanStep['type'] {
        if (description.toLowerCase().includes('code') || 
            description.toLowerCase().includes('function') ||
            description.toLowerCase().includes('class')) {
            return 'code';
        }
        if (description.toLowerCase().includes('analyze') ||
            description.toLowerCase().includes('review')) {
            return 'analysis';
        }
        if (description.toLowerCase().includes('validate') ||
            description.toLowerCase().includes('verify')) {
            return 'validation';
        }
        return 'general';
    }

    private determineRequiredModel(description: string): string {
        const stepType = this.determineStepType(description);
        switch (stepType) {
            case 'code':
            case 'analysis':
                return this.CODE_MODEL;
            default:
                return this.CHAT_MODEL;
        }
    }

    async executeNextStep(): Promise<void> {
        if (!this.currentPlan || this.currentPlan.status === 'completed') {
            return;
        }

        const currentStep = this.currentPlan.steps[this.currentPlan.currentStepIndex];
        
        // Validate step dependencies
        if (currentStep.dependencies?.length) {
            const unfinishedDeps = currentStep.dependencies.filter(depId => {
                const depStep = this.currentPlan!.steps.find(s => s.id === depId);
                return !depStep || depStep.status !== 'completed';
            });
            if (unfinishedDeps.length > 0) {
                throw new Error(`Cannot execute step ${currentStep.id}: Dependencies not met: ${unfinishedDeps.join(', ')}`);
            }
        }

        try {
            // Check if we need to switch models
            if (currentStep.requiresModel !== this.currentModel) {
                this.outputChannel.appendLine(`Switching from ${this.currentModel} to ${currentStep.requiresModel} for step ${currentStep.id}`);
                await this.switchModel(currentStep.requiresModel);
            }

            // Execute the step
            currentStep.status = 'in_progress';
            const result = await this.executeStep(currentStep);
            currentStep.result = result;
            currentStep.status = 'completed';

            // Save step context if it produced any
            if (result.data) {
                await this.memoryService.addStepContext(
                    this.currentPlan.id,
                    currentStep.id,
                    result.data
                );
            }

            // Move to next step
            this.currentPlan.currentStepIndex++;
            if (this.currentPlan.currentStepIndex >= this.currentPlan.steps.length) {
                this.currentPlan.status = 'completed';
            }

            // Save plan state after successful execution
            await this.memoryService.savePlanState(this.currentPlan);

            // If we used Qwen for coding, switch back to Hermes3 for next steps
            if (this.currentModel === this.CODE_MODEL) {
                await this.switchModel(this.CHAT_MODEL);
            }
        } catch (error) {
            currentStep.status = 'failed';
            currentStep.retryCount = (currentStep.retryCount || 0) + 1;
            
            if (currentStep.retryCount < 3) {
                // Retry the step
                this.currentPlan.status = 'retrying';
                await this.memoryService.savePlanState(this.currentPlan);
                return;
            }
            
            this.currentPlan.status = 'failed';
            await this.memoryService.savePlanState(this.currentPlan);
            throw error;
        }
    }

    private async executeStep(step: PlanStep): Promise<TaskResult> {
        try {
            // Pre-execution validation
            const validationContext: PlanValidationContext = {
                objective: this.currentPlan?.objective || '',
                currentStep: step,
                previousSteps: this.currentPlan?.steps.slice(0, this.currentPlan.currentStepIndex) || [],
                memory: {
                    codeChanges: [],
                    analysisResults: [],
                    errors: []
                },
                prompt: step.description
            };
    
            // Get proactive suggestions from PlanAdaptingService
            if (this.currentPlan) {
                const suggestions = await this.planAdaptingService.suggestPlanModifications(this.currentPlan);
                
                // Handle high-confidence modifications before execution
                const highConfidenceMods = suggestions.modifications.filter(mod => mod.confidence > 0.8);
                if (highConfidenceMods.length > 0) {
                    await this.handlePlanRevision(highConfidenceMods);
                    // Re-get the step in case it was modified
                    step = this.currentPlan.steps.find(s => s.id === step.id) || step;
                }
    
                // Log any high-severity risks
                suggestions.risks
                    .filter(risk => risk.severity === 'high')
                    .forEach(risk => {
                        this.outputChannel.appendLine(`Risk detected: ${risk.type} - ${risk.description}`);
                    });
            }
    
            const preValidation = await this.planValidatorService.validatePlanStep(validationContext);
            if (!preValidation.isValid) {
                if (preValidation.requiresPlanRevision) {
                    await this.handlePlanRevision(preValidation.suggestedRevisions || []);
                }
                return {
                    success: false,
                    error: preValidation.errors?.join(', '),
                    data: null,
                    modelUsed: this.currentModel
                };
            }
    
            // Original task execution logic
            const task: Task = {
                id: step.id,
                type: this.mapPlanStepTypeToTaskType(step.type),
                prompt: step.description,
                objective: step.description,
                requiresModelSwitch: false,
                callback: () => {}
            };
    
            let result: TaskResult;
            if (step.type === 'code') {
                const editor = vscode.window.activeTextEditor;
                const filePath = editor?.document.uri.fsPath || await this.determineTargetFilePath(step.description);
                
                // Get the code generation result from ollama
                result = await this.ollamaService.executeTask(task);
                
                if (result.success && result.data) {
                    // Validate the operation is safe
                    const validation = await this.fileSystemService.validateFileOperation(
                        'write',
                        filePath
                    );
    
                    if (validation.safe) {
                        try {
                            // Format the content according to the file type
                            const formattedContent = await this.fileSystemService.formatFileContent(
                                filePath,
                                result.data
                            );
    
                            // Create or update the file
                            await vscode.workspace.fs.writeFile(
                                vscode.Uri.file(filePath),
                                Buffer.from(formattedContent, 'utf8')
                            );
    
                            this.outputChannel.appendLine(`Successfully wrote to file: ${filePath}`);
                        } catch (error) {
                            this.outputChannel.appendLine(`Failed to write file: ${error}`);
                            throw error;
                        }
                    } else {
                        throw new Error(`Unsafe file operation: ${validation.reason}`);
                    }
                }
            } else {
                // For non-code tasks, just execute normally
                result = await this.ollamaService.executeTask(task);
            }
    
            // Learn from the execution result
            if (this.currentPlan) {
                await this.planAdaptingService.learnFromPlanExecution(
                    this.currentPlan,
                    result.success
                );
            }
    
            // Post-execution validation
            validationContext.executionResult = result;
            const postValidation = await this.planValidatorService.validatePlanStep(validationContext);
    
            if (!postValidation.isValid) {
                if (postValidation.requiresPlanRevision) {
                    await this.handlePlanRevision(postValidation.suggestedRevisions || []);
                }
                return {
                    success: false,
                    error: postValidation.errors?.join(', '),
                    data: result.data,
                    modelUsed: this.currentModel
                };
            }
    
            return result;
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error during step execution',
                data: null,
                modelUsed: this.currentModel
            };
        }
    }

    private mapPlanStepTypeToTaskType(stepType: PlanStep['type']): TaskType {
        switch (stepType) {
            case 'code':
                return 'code';
            case 'analysis':
                return 'codeAnalysis';
            case 'validation':
                return 'general';
            default:
                return 'general';
        }
    }

    private async determineTargetFilePath(description: string): Promise<string> {
        const context = this.fileSystemService.getWorkspaceContext();
        if (!context) {
            throw new Error('No workspace found');
        }

        // Extract filename from description
        const filenameMatch = description.match(/['"](.*?)['"]/);
        if (!filenameMatch) {
            throw new Error('No filename specified in the task description');
        }
        const filename = filenameMatch[1];

        // If a directory is specified in the description, use it
        let targetDir = '';
        const dirMatch = description.match(/(?:in|to|into|under|within)\s+(?:the\s+)?(?:directory\s+)?['"]([^'"]+)['"]/i);
        if (dirMatch) {
            targetDir = dirMatch[1];
        }

        // Create the initial suggested path
        const suggestedPath = targetDir 
            ? path.join(context.workspacePath, targetDir, filename)
            : path.join(context.workspacePath, filename);

        // Use workspace analysis to determine best location
        const analysis = await this.fileSystemService.analyzeWorkspaceForFile(suggestedPath);
        
        // If analysis suggests a better location and no specific directory was requested, use it
        if (analysis.suggestedLocation && !targetDir) {
            return path.join(analysis.suggestedLocation, filename);
        }

        // Ensure target directory exists
        const finalDir = path.dirname(suggestedPath);
        if (!fs.existsSync(finalDir)) {
            fs.mkdirSync(finalDir, { recursive: true });
        }

        return suggestedPath;
    }

    async handleTask(input: string): Promise<string> {
        // First try to restore any active plan from memory
        if (!this.currentPlan) {
            this.currentPlan = await this.memoryService.getActivePlan();
        }

        // Check if we have an ongoing plan that's not completed
        if (this.currentPlan && 
            this.currentPlan.status !== 'completed' && 
            this.currentPlan.status !== 'failed') {
            
            // Continue with the current plan
            this.outputChannel.appendLine(`Continuing existing plan at step ${this.currentPlan.currentStepIndex + 1}`);
            await this.executeNextStep();
            
            // Return progress information
            const totalSteps = this.currentPlan.steps.length;
            const currentStep = this.currentPlan.currentStepIndex;
            return `Executed step ${currentStep} of ${totalSteps}. ${
                currentStep === totalSteps ? 'Plan completed!' : 'More steps remaining.'
            }`;
        }
    
        // If no current plan, analyze the task
        const analysis = await this.analyzeTask(input);
        this.outputChannel.appendLine(`Finished analyzing task.`);
        
        // Create a new plan only for complex tasks without an existing plan
        if (analysis.type === 'code' || 
            input.toLowerCase().includes('create') || 
            input.toLowerCase().includes('edit')) {
            
            const plan = await this.createExecutionPlan(input);
            this.currentPlan = plan;
            await this.executeNextStep();
            
            const totalSteps = plan.steps.length;
            return `Created new plan with ${totalSteps} steps. Executed step 1. ${
                totalSteps > 1 ? 'More steps remaining.' : 'Plan completed!'
            }`;
        }
    
        // For simpler tasks, execute directly as before
        const taskType = this.mapContextTypeToTaskType(analysis.type);
        const task: Task = {
            id: Math.random().toString(36).substring(7),
            type: taskType,
            prompt: input,
            objective: 'Execute task',
            requiresModelSwitch: analysis.requiresModelSwitch,
            codeContext: analysis.codeContext,
            callback: () => {}
        };
    
        const result = await this.processTask(task);
        return result.data;
    }

    async handleCommandRejection(operation: CommandOperation, reason: string): Promise<void> {
        // Log the rejection for learning
        this.outputChannel.appendLine(`Command rejected: ${operation.command}`);
        this.outputChannel.appendLine(`Reason: ${reason}`);
        
        // Store in memory service using existing terminalLogs
        await this.memoryService.addTerminalLog(
            operation.command,
            `Rejected: ${reason}`
        );
        
        // If there's a current plan, mark the current step as failed
        if (this.currentPlan) {
            const currentStep = this.currentPlan.steps[this.currentPlan.currentStepIndex];
            if (currentStep) {
                currentStep.status = 'failed';
                currentStep.result = {
                    success: false,
                    data: null,
                    error: reason,
                    modelUsed: this.currentModel
                };
            }
        }
    }
    
    async executeCommandTask(task: Task): Promise<TaskResult> {
        if (!task.commandOperation) {
            return {
                success: false,
                data: null,
                error: 'No command operation provided',
                modelUsed: this.currentModel
            };
        }
    
        try {
            // Propose and execute the command
            const result = await this.commandService.proposeCommand(task.commandOperation);
            
            return {
                success: result.success,
                data: result,
                modelUsed: this.currentModel,
                commandResult: result
            };
        } catch (error: unknown) {
            return {
                success: false,
                data: null,
                error: error instanceof Error ? error.message : String(error),
                modelUsed: this.currentModel
            };
        }
    }

    private async processTask(task: Task): Promise<TaskResult> {
        this.outputChannel.appendLine(`Beginning processTask`);
        try {
            // Switch model if needed
            if (task.requiresModelSwitch) {
                const targetModel = this.getTargetModel(task.type);
                if (targetModel !== this.currentModel) {
                    await this.switchModel(targetModel);
                }
            }
    
            // Handle different task types
            let result: TaskResult;
            switch (task.type) {
                case 'command':
                    result = await this.executeCommandTask(task);
                    break;
                default:
                    // Execute other task types with ollama service
                    result = await this.ollamaService.executeTask(task);
                    break;
            }
    
            this.outputChannel.appendLine(`Finished executeTask`);
    
            // Validate result if needed
            const validation = await this.validateResult(result, {
                type: task.type,
                requiresModelSwitch: false,
                targetModel: this.currentModel,
                validationRequired: true,
                plan: undefined,
                execution: undefined
            });
            if (!validation.isValid) {
                throw new Error(`Task result validation failed: ${validation.errors?.join(', ')}`);
            }
    
            return result;
        } catch (error: any) {
            this.outputChannel.appendLine(`Task execution failed: ${error.message}`);
            return {
                success: false,
                error: error.message,
                data: null,
                modelUsed: this.currentModel
            };
        }
    }

    private async ensureModel(modelName: string): Promise<boolean> {
        try {
            if (this.currentModel === modelName) {
                const state = this.modelStates.get(modelName);
                if (state?.isRunning) {
                    return true;
                }
            }

            const success = await this.switchModel(modelName);
            if (success) {
                this.currentModel = modelName;
                
                this.modelStates.set(modelName, {
                    isRunning: true,
                    lastUsed: new Date(),
                    performance: {
                        avgResponseTime: 0,
                        errorRate: 0,
                        successfulTasks: 0,
                        failedTasks: 0
                    }
                });
                
                return true;
            }
            return false;
        } catch (error) {
            this.outputChannel.appendLine(`Failed to ensure model ${modelName}: ${error}`);
            return false;
        }
    }

    private getCurrentContext(): any {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
            return null;
        }

        return {
            fileName: activeEditor.document.fileName,
            language: activeEditor.document.languageId,
            selectedText: activeEditor.selection.isEmpty ? 
                         null : 
                         activeEditor.document.getText(activeEditor.selection),
            cursorPosition: activeEditor.selection.active,
            visibleRange: activeEditor.visibleRanges[0]
        };
    }

    private async handlePlanRevision(revisions: Array<{ 
        type: 'modify' | 'insert' | 'remove' | 'reorder', 
        step?: PlanStep, 
        reason: string 
    }>) {
        if (!this.currentPlan) {
            throw new Error('No active plan to revise');
        }
    
        // Store the original plan state
        await this.memoryService.savePlanState(this.currentPlan);
    
        for (const revision of revisions) {
            switch (revision.type) {
                case 'modify':
                    if (revision.step) {
                        const stepIndex = this.currentPlan.steps.findIndex(s => s.id === revision.step!.id);
                        if (stepIndex !== -1) {
                            // Create a new step with modifications
                            const modifiedStep = await this.createModifiedStep(revision.step, revision.reason);
                            this.currentPlan.steps[stepIndex] = modifiedStep;
                            // Store step context
                            await this.memoryService.addStepContext(
                                this.currentPlan.id,
                                modifiedStep.id,
                                { modificationReason: revision.reason, originalStepId: revision.step.id }
                            );
                        }
                    }
                    break;
    
                case 'insert':
                    // Create a new step based on the reason
                    const newStep = await this.createNewStep(revision.reason);
                    if (revision.step) {
                        // Insert after the specified step
                        const stepIndex = this.currentPlan.steps.findIndex(s => s.id === revision.step!.id);
                        if (stepIndex !== -1) {
                            this.currentPlan.steps.splice(stepIndex + 1, 0, newStep);
                            // Store step context
                            await this.memoryService.addStepContext(
                                this.currentPlan.id,
                                newStep.id,
                                { insertReason: revision.reason, afterStepId: revision.step.id }
                            );
                        }
                    } else {
                        // Add to the end of the plan
                        this.currentPlan.steps.push(newStep);
                        // Store step context
                        await this.memoryService.addStepContext(
                            this.currentPlan.id,
                            newStep.id,
                            { insertReason: revision.reason }
                        );
                    }
                    break;
    
                case 'remove':
                    if (revision.step) {
                        this.currentPlan.steps = this.currentPlan.steps.filter(s => s.id !== revision.step!.id);
                    }
                    break;
    
                case 'reorder':
                    if (revision.step) {
                        // Move the step to a new position
                        const oldIndex = this.currentPlan.steps.findIndex(s => s.id === revision.step!.id);
                        if (oldIndex !== -1) {
                            const step = this.currentPlan.steps[oldIndex];
                            this.currentPlan.steps.splice(oldIndex, 1); // Remove from old position
                            
                            // Insert at new position (for now, we'll put it at the end)
                            // In a real implementation, you might want to pass the target position in the revision
                            this.currentPlan.steps.push(step);
                            
                            await this.memoryService.addStepContext(
                                this.currentPlan.id,
                                step.id,
                                { reorderReason: revision.reason }
                            );
                        }
                    }
                    break;
            }
        }
    
        // Update plan status
        this.currentPlan.status = 'retrying';
        
        // Save the updated plan state
        await this.memoryService.savePlanState(this.currentPlan);
    }

    private async createModifiedStep(originalStep: PlanStep, reason: string): Promise<PlanStep> {
        // Use the code model to generate a modified step
        await this.ensureModel(this.CODE_MODEL);
        
        const prompt = `Given the original step: "${originalStep.description}"
                       and the modification reason: "${reason}"
                       Generate a new step description that addresses the issue while maintaining the original objective.`;
        
        const response = await this.ollamaService.executeTask({
            id: `modify-step-${Date.now()}`,
            type: 'general',
            prompt: prompt,
            objective: 'Generate modified step description',
            requiresModelSwitch: false,
            callback: () => {}
        });
        
        return {
            ...originalStep,
            description: response.data,
            id: `${originalStep.id}-modified-${Date.now()}`,
            status: 'pending'
        };
    }

    private async createNewStep(reason: string): Promise<PlanStep> {
        // Use the code model to generate a new step
        await this.ensureModel(this.CODE_MODEL);
        
        const prompt = `Based on the reason: "${reason}"
                       Generate a new step description that addresses this requirement.`;
        
        const response = await this.ollamaService.executeTask({
            id: `new-step-${Date.now()}`,
            type: 'general',
            prompt: prompt,
            objective: 'Generate new step description',
            requiresModelSwitch: false,
            callback: () => {}
        });
        
        return {
            id: `step-${Date.now()}`,
            type: 'code',
            description: response.data,
            requiresModel: this.CODE_MODEL,
            status: 'pending'
        };
    }

    private async validateResult(result: TaskResult, context: TaskContext): Promise<ValidationResult> {
        try {
            // Switch back to Hermes3 for validation if needed
            if (this.currentModel !== this.CHAT_MODEL) {
                await this.switchModel(this.CHAT_MODEL);
            }

            const validationPrompt = `Validate the following result for a ${context.type} task:
Result: ${JSON.stringify(result.data)}
Context: ${JSON.stringify({
    type: context.type,
    requiresModelSwitch: context.requiresModelSwitch,
    targetModel: context.targetModel,
    validationRequired: context.validationRequired
})}

Respond with a JSON object containing:
{
    "isValid": boolean,
    "errors": string[] | null,
    "suggestions": string[] | null
}`;

            const response = await this.ollamaService.generateResponse(validationPrompt, false);
            const validation = JSON.parse(response);

            return {
                isValid: validation.isValid,
                errors: validation.errors || [],
                suggestions: validation.suggestions || []
            };
        } catch (error) {
            return {
                isValid: false,
                errors: [`Validation failed: ${error}`],
                suggestions: []
            };
        }
    }
}