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
exports.ModelCoordinator = void 0;
const vscode = __importStar(require("vscode"));
const memoryService_1 = require("./memoryService");
const fileSystemService_1 = require("./fileSystemService");
const registry_1 = require("../languages/registry");
class ModelCoordinator {
    constructor(ollamaService, context) {
        this.ollamaService = ollamaService;
        this.modelStates = new Map();
        this.taskQueue = [];
        this.currentTask = null;
        this.currentPlan = null;
        this.CHAT_MODEL = 'hermes3:8b';
        this.CODE_MODEL = 'qwen2.5-coder:7b';
        this.VISION_MODEL = 'llama3.2-vision:11b';
        this.outputChannel = vscode.window.createOutputChannel('Model Coordinator');
        this.currentModel = this.CHAT_MODEL;
        this.memoryService = new memoryService_1.MemoryService(context);
        this.fileSystemService = new fileSystemService_1.FileSystemService();
        this.languageRegistry = registry_1.LanguageRegistry.getInstance();
        this.initializeModelStates();
    }
    initializeModelStates() {
        const initialState = {
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
    async getCodeContext(filePath) {
        const handler = this.languageRegistry.getHandlerForFile(filePath);
        if (!handler)
            return undefined;
        const analysis = await this.fileSystemService.analyzeFile(filePath);
        if (!analysis.content || !analysis.languageAnalysis)
            return undefined;
        return {
            filePath,
            language: handler.languageId,
            imports: analysis.languageAnalysis.imports,
            dependencies: analysis.languageAnalysis.dependencies,
            structure: analysis.languageAnalysis.structure
        };
    }
    async validateCodeChange(filePath, newContent, context) {
        const handler = this.languageRegistry.getHandlerForFile(filePath);
        if (!handler) {
            return { isValid: false, errors: ['No language handler available'] };
        }
        // Syntax validation
        if (!handler.validateSyntax(newContent)) {
            return { isValid: false, errors: ['Invalid syntax'] };
        }
        // Import validation
        if (!handler.validateImports(newContent)) {
            return { isValid: false, errors: ['Invalid imports'] };
        }
        // Structure validation
        if (!handler.validateStructure(newContent)) {
            return { isValid: false, errors: ['Invalid code structure'] };
        }
        return { isValid: true };
    }
    async prepareCodePrompt(input, context) {
        // Enhance the prompt with language-specific context
        return `
Language: ${context.language}
Current Imports: ${context.imports.join(', ')}
Current Structure:
${JSON.stringify(context.structure, null, 2)}

Task: ${input}

Provide code that:
1. Maintains consistent style with existing code
2. Handles imports correctly
3. Follows language-specific best practices
4. Integrates with existing code structure
`;
    }
    async delegateTask(task) {
        const taskId = Math.random().toString(36).substring(7);
        const fullTask = {
            ...task,
            id: taskId,
            requiresModelSwitch: this.determineIfModelSwitchRequired(task.type)
        };
        return new Promise((resolve, reject) => {
            fullTask.callback = resolve;
            this.taskQueue.push(fullTask);
            if (!this.currentTask) {
                this.processNextTask().catch(reject);
            }
        });
    }
    determineIfModelSwitchRequired(taskType) {
        const targetModel = this.getTargetModel(taskType);
        return targetModel !== this.currentModel;
    }
    getTargetModel(taskType) {
        switch (taskType) {
            case 'code':
            case 'codeAnalysis':
                return this.CODE_MODEL;
            case 'vision':
                return this.VISION_MODEL;
            default:
                return this.CHAT_MODEL;
        }
    }
    async processNextTask() {
        if (this.taskQueue.length === 0 || this.currentTask)
            return;
        this.currentTask = this.taskQueue.shift();
        const startTime = Date.now();
        try {
            // 1. Pre-execution validation
            const validationResult = await this.validateTask(this.currentTask);
            if (!validationResult.isValid) {
                throw new Error(`Task validation failed: ${validationResult.errors?.join(', ')}`);
            }
            // 2. Model switching if needed
            if (this.currentTask.requiresModelSwitch) {
                const targetModel = this.getTargetModel(this.currentTask.type);
                await this.switchModel(targetModel);
                this.currentModel = targetModel;
            }
            // 3. Execute task
            const result = await this.executeTask(this.currentTask);
            // 4. Update performance metrics
            const modelState = this.modelStates.get(this.currentModel);
            modelState.performance.successfulTasks++;
            modelState.performance.avgResponseTime =
                (modelState.performance.avgResponseTime * (modelState.performance.successfulTasks - 1) +
                    (Date.now() - startTime)) / modelState.performance.successfulTasks;
            // 5. Invoke callback with result
            this.currentTask.callback(result);
        }
        catch (error) {
            // Handle task failure
            const modelState = this.modelStates.get(this.currentModel);
            modelState.performance.failedTasks++;
            modelState.performance.errorRate =
                modelState.performance.failedTasks /
                    (modelState.performance.successfulTasks + modelState.performance.failedTasks);
            this.currentTask.callback({
                success: false,
                error: error.message,
                data: null,
                modelUsed: this.currentModel
            });
        }
        finally {
            this.currentTask = null;
            // Process next task if any
            if (this.taskQueue.length > 0) {
                await this.processNextTask();
            }
        }
    }
    async validateTask(task) {
        const targetModel = this.getTargetModel(task.type);
        const modelState = this.modelStates.get(targetModel);
        if (!modelState?.isRunning) {
            return {
                isValid: false,
                errors: [`Model ${targetModel} is not running`]
            };
        }
        return { isValid: true };
    }
    async switchModel(targetModel) {
        if (targetModel === this.currentModel)
            return;
        this.outputChannel.appendLine(`Switching from ${this.currentModel} to ${targetModel}`);
        const success = await this.ollamaService.switchModel(targetModel);
        if (!success) {
            throw new Error(`Failed to switch to model ${targetModel}`);
        }
        this.currentModel = targetModel;
        const modelState = this.modelStates.get(targetModel);
        if (modelState) {
            modelState.lastUsed = new Date();
        }
    }
    async executeTask(task) {
        return await this.ollamaService.executeTask(task);
    }
    async handleTaskFailure(task, error) {
        this.outputChannel.appendLine(`Task ${task.id} failed: ${error}`);
        // If it's a code task that failed, we might want to retry with the chat model
        if (task.type === 'code' && this.currentModel === this.CODE_MODEL) {
            this.outputChannel.appendLine('Retrying failed code task with chat model...');
            try {
                await this.switchModel(this.CHAT_MODEL);
                const result = await this.executeTask(task);
                task.callback({
                    success: true,
                    data: result,
                    modelUsed: this.CHAT_MODEL
                });
            }
            catch (retryError) {
                task.callback({
                    success: false,
                    error: error.message,
                    data: null,
                    modelUsed: this.currentModel
                });
            }
        }
        else {
            task.callback({
                success: false,
                error: error.message,
                data: null,
                modelUsed: this.currentModel
            });
        }
    }
    updatePerformanceMetrics(model, execution) {
        const state = this.modelStates.get(model);
        if (!state)
            return;
        const { duration, success } = execution;
        // Update average response time
        const oldTotal = state.performance.avgResponseTime * (state.performance.successfulTasks + state.performance.failedTasks);
        const newTotal = oldTotal + duration;
        const newCount = state.performance.successfulTasks + state.performance.failedTasks + 1;
        state.performance.avgResponseTime = newTotal / newCount;
        // Update success/failure counts
        if (success) {
            state.performance.successfulTasks++;
        }
        else {
            state.performance.failedTasks++;
        }
        // Update error rate
        state.performance.errorRate = state.performance.failedTasks / newCount;
    }
    getModelState(model) {
        return this.modelStates.get(model);
    }
    getCurrentModel() {
        return this.currentModel;
    }
    async createExecutionPlan(objective) {
        // Ensure we're using Hermes3 for planning
        if (this.currentModel !== this.CHAT_MODEL) {
            await this.switchModel(this.CHAT_MODEL);
        }
        // Ask Hermes3 to create a plan
        const planTask = {
            id: Math.random().toString(36).substring(7),
            type: 'general',
            prompt: `Create a detailed execution plan for the following objective: ${objective}. 
                    Break it down into steps, specifying which steps require code operations.`,
            objective: 'Create execution plan',
            requiresModelSwitch: false,
            callback: () => { }
        };
        const planResult = await this.ollamaService.executeTask(planTask);
        // Convert the result into a structured plan
        const plan = {
            objective,
            steps: this.parsePlanSteps(planResult.data),
            currentStepIndex: 0,
            modelSwitchRequired: false,
            status: 'planning'
        };
        this.currentPlan = plan;
        return plan;
    }
    parsePlanSteps(planData) {
        // Implementation will depend on how Hermes3 structures its response
        // This is a simplified version
        return planData.steps.map((step, index) => ({
            id: `step_${index}`,
            description: step.description,
            type: this.determineStepType(step.description),
            requiresModel: this.determineRequiredModel(step.description),
            dependencies: [],
            status: 'pending'
        }));
    }
    determineStepType(description) {
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
    determineRequiredModel(description) {
        const stepType = this.determineStepType(description);
        switch (stepType) {
            case 'code':
            case 'analysis':
                return this.CODE_MODEL;
            default:
                return this.CHAT_MODEL;
        }
    }
    async executeNextStep() {
        if (!this.currentPlan || this.currentPlan.status === 'completed') {
            return;
        }
        const currentStep = this.currentPlan.steps[this.currentPlan.currentStepIndex];
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
            // Move to next step
            this.currentPlan.currentStepIndex++;
            if (this.currentPlan.currentStepIndex >= this.currentPlan.steps.length) {
                this.currentPlan.status = 'completed';
            }
            // If we used Qwen for coding, switch back to Hermes3 for next steps
            if (this.currentModel === this.CODE_MODEL) {
                await this.switchModel(this.CHAT_MODEL);
            }
        }
        catch (error) {
            currentStep.status = 'failed';
            this.currentPlan.status = 'failed';
            throw error;
        }
    }
    async executeStep(step) {
        const task = {
            id: step.id,
            type: this.mapPlanStepTypeToTaskType(step.type),
            prompt: step.description,
            objective: step.description,
            requiresModelSwitch: false,
            callback: () => { }
        };
        if (step.type === 'code') {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                throw new Error('No active editor');
            }
            const filePath = editor.document.uri.fsPath;
            const codeContext = await this.getCodeContext(filePath);
            task.codeContext = codeContext;
        }
        return await this.ollamaService.executeTask(task);
    }
    mapPlanStepTypeToTaskType(stepType) {
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
    async analyzeTask(input) {
        // Analyze task type and requirements
        const isCodeTask = input.toLowerCase().includes('code') ||
            input.toLowerCase().includes('function') ||
            input.toLowerCase().includes('class');
        const isImageTask = input.toLowerCase().includes('image') ||
            input.toLowerCase().includes('picture') ||
            input.toLowerCase().includes('photo');
        let type = 'general';
        let targetModel = this.CHAT_MODEL;
        let requiresModelSwitch = false;
        if (isCodeTask) {
            type = 'code';
            targetModel = this.CODE_MODEL;
            requiresModelSwitch = true;
        }
        else if (isImageTask) {
            type = 'image';
            targetModel = this.VISION_MODEL;
            requiresModelSwitch = true;
        }
        return {
            type,
            targetModel,
            requiresModelSwitch,
            validationRequired: type === 'code'
        };
    }
    async handleTask(input) {
        const context = await this.analyzeTask(input);
        if (context.requiresModelSwitch) {
            await this.switchModel(context.targetModel);
        }
        const task = {
            id: Math.random().toString(36).substring(7),
            type: this.mapContextTypeToTaskType(context.type),
            prompt: input,
            objective: input,
            requiresModelSwitch: context.requiresModelSwitch,
            callback: () => { }
        };
        if (context.type === 'code') {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                throw new Error('No active editor');
            }
            const filePath = editor.document.uri.fsPath;
            const codeContext = await this.getCodeContext(filePath);
            task.codeContext = codeContext;
        }
        const result = await this.ollamaService.executeTask(task);
        if (context.validationRequired) {
            const validationResult = await this.validateTaskResult(result.data);
            if (!validationResult.isValid) {
                throw new Error(`Validation failed: ${validationResult.reason}`);
            }
        }
        return result.data;
    }
    mapContextTypeToTaskType(contextType) {
        switch (contextType) {
            case 'code':
                return 'code';
            case 'image':
                return 'vision';
            default:
                return 'general';
        }
    }
    async validateTaskResult(result) {
        // Implement output validation logic
        if (!result) {
            return {
                isValid: false,
                reason: 'Empty result received'
            };
        }
        // Add more validation as needed
        return { isValid: true };
    }
}
exports.ModelCoordinator = ModelCoordinator;
//# sourceMappingURL=modelCoordinator.js.map