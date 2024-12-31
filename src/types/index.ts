import * as vscode from 'vscode';

export interface OllamaModel {
    name: string;
    digest: string;
    size: number;
    modified_at: string;
    capabilities?: string[];
}

export interface LineChange {
    lineNumber: number;
    newLine: string;
}

export interface FileChange {
    filePath: string;
    changes: LineChange[];
    oldContent?: string;
    newContent?: string;
}

export type TaskType = 'code' | 'image' | 'general' | 'codeAnalysis' | 'command';

export interface SymbolReference {
    name: string;
    kind: vscode.SymbolKind;
    location: vscode.Location;
}

export interface CallHierarchyItem {
    name: string;
    kind: vscode.SymbolKind;
    detail?: string;
    uri: vscode.Uri;
    range: vscode.Range;
    selectionRange: vscode.Range;
}

export interface TypeHierarchyItem {
    name: string;
    kind: vscode.SymbolKind;
    detail?: string;
    uri: vscode.Uri;
    range: vscode.Range;
    selectionRange: vscode.Range;
}

export interface TaskResult {
    success: boolean;
    data: any;
    error?: string;
    modelUsed: string;
    analysis?: TaskAnalysis;
    plan?: ExecutionPlan;
    execution?: TaskExecution;
    commandResult?: CommandResult;
}

export interface TaskAnalysis {
    taskType: TaskType;
    requiresSpecialist: boolean;
    targetModel: string;
    complexity: number;
    estimatedTime?: number;
    validationErrors?: string[];
    codeNavigation?: {
        analyzedSymbol?: string;
        analyzedFunction?: string;
        analyzedType?: string;
        references?: SymbolReference[];
        callHierarchy?: CallHierarchyItem;
        typeHierarchy?: TypeHierarchyItem;
    };
}

export interface TaskContext {
    type: TaskType;
    requiresModelSwitch: boolean;
    targetModel: string;
    validationRequired: boolean;
    plan?: ExecutionPlan;
    execution?: TaskExecution;
    codeContext?: CodeContext;
}

export interface TaskExecution {
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    steps: ExecutionStep[];
    currentStep?: number;
    startTime?: number;
    endTime?: number;
    error?: string;
}

export interface ExecutionStep {
    id: string;
    description: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    result?: any;
    error?: string;
    startTime?: number;
    endTime?: number;
}

export interface Task {
    id: string;
    type: TaskType;
    prompt: string;
    objective: string;
    requiresModelSwitch: boolean;
    callback: (result: TaskResult) => void;
    codeContext?: CodeContext;
    isDelegated?: boolean;
    commandOperation?: CommandOperation;
}

export interface ValidationResult {
    isValid: boolean;
    errors?: string[];
    suggestions?: string[];
    reason?: string;
    impactedFiles?: string[];
}

export interface PlanValidationContext {
    objective: string;
    currentStep: PlanStep;
    previousSteps: PlanStep[];
    memory: {
        codeChanges: Array<{path: string; diff: string}>;
        analysisResults: Array<{path: string; analysis: string}>;
        errors: string[];
    };
    prompt: string;
    executionResult?: TaskResult;
}

export interface PlanValidationResult extends ValidationResult {
    requiresPlanRevision: boolean;
    suggestedRevisions?: {
        type: 'modify' | 'insert' | 'remove';
        step?: PlanStep;
        reason: string;
    }[];
}

export interface ErrorCorrection {
    errorType: 'syntax' | 'semantic' | 'dependency' | 'memory' | 'impact';
    severity: 'low' | 'medium' | 'high' | 'critical';
    context: {
        file?: string;
        line?: number;
        code?: string;
        relatedSymbols?: string[];
    };
    suggestedFixes: Array<{
        description: string;
        changes: ModelFileOperation[];
        confidence: number;
    }>;
}

export interface ModelState {
    isRunning: boolean;
    lastUsed: Date;
    performance: {
        avgResponseTime: number;
        errorRate: number;
        successfulTasks: number;
        failedTasks: number;
    };
}

export interface PlanStep {
    id: string;
    description: string;
    type: 'code' | 'analysis' | 'validation' | 'general';
    requiresModel: string;
    dependencies?: string[];
    retryCount?: number;
    context?: any;
    status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'retrying';
    result?: TaskResult;
    commandValidation?: CommandValidation;
}

export interface ExecutionPlan {
    id: string;
    objective: string;
    steps: PlanStep[];
    currentStepIndex: number;
    modelSwitchRequired: boolean;
    status: 'planning' | 'executing' | 'completed' | 'failed' | 'retrying';
}

export interface CodeOperation {
    type: 'create' | 'edit' | 'analyze';
    targetPath: string;
    language?: string;
    content?: string;
    changes?: FileChange[];
    analysis?: CodeAnalysisResult;
}

export interface CodeAnalysisResult {
    imports: string[];
    dependencies: string[];
    functions: {
        name: string;
        params: string[];
        returnType?: string;
        complexity: number;
    }[];
    issues: {
        type: 'error' | 'warning';
        message: string;
        line?: number;
        column?: number;
    }[];
    suggestions: string[];
}

export interface CodeContext {
    filePath: string;
    language: string;
    imports: string[];
    dependencies: string[];
    structure: Array<{
        type: 'class' | 'function' | 'interface' | 'variable' | 'other';
        name: string;
        startLine: number;
        endLine: number;
    }>;
    symbolReferences?: SymbolReference[];
    callHierarchy?: CallHierarchyItem;
    typeHierarchy?: TypeHierarchyItem;
    impactedFiles?: string[];
    syntaxErrors?: vscode.Diagnostic[];
}

export interface CodeLocation {
    filePath: string;
    line: number;
    column: number;
}

export interface ModelFileEdit {
    startLine: number;
    endLine: number;
    newContent: string;
    oldContent?: string;  // Add oldContent as optional property
}

export interface ModelFileOperation {
    type: 'create' | 'edit' | 'delete' | 'createDirectory';
    filePath?: string;
    targetDirectory?: string;
    content?: string;
    language?: string;
    edits?: ModelFileEdit[];  // Use ModelFileEdit interface instead of inline type
}

export interface ModelResponse {
    operations: Array<ModelFileOperation | CommandOperation>;
    explanation: string;
    requiresValidation: boolean;
}

export interface CommandOperation {
    type: 'execute' | 'validate' | 'analyze';
    command: string;
    workingDirectory?: string;
    environment?: Record<string, string>;
    timeout?: number;
    requiresSudo?: boolean;
    expectedOutput?: {
        stdout?: string | RegExp;
        exitCode?: number;
    };
}

export interface CommandResult {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    duration: number;
    command: string;
    workingDirectory: string;
}

export interface CommandValidation {
    isValid: boolean;
    risks: Array<{
        level: 'low' | 'medium' | 'high' | 'critical';
        description: string;
    }>;
    suggestions?: string[];
    alternativeCommands?: string[];
}

export interface Pattern {
    id: string;
    errorType: 'syntax' | 'semantic' | 'dependency' | 'memory' | 'impact';
    context: {
        file: string;
        errorLocation: CodeLocation;
        codeSnippet: string;
        relatedSymbols: string[];
    };
    stats: {
        successCount: number;
        failureCount: number;
        lastUsed: string;
        contexts: Set<string>;
    };
    strategies: {
        successful: Array<{
            fixes: ModelFileOperation[];
            successRate: number;
            contexts: string[];
        }>;
        failed: Array<{
            fixes: ModelFileOperation[];
            failureRate: number;
            errors: string[];
        }>;
    };
}

export interface ThresholdData {
    baseThreshold: number;
    contextual: Map<string, {
        threshold: number;
        successRate: number;
        sampleSize: number;
    }>;
    history: Array<{
        context: string;
        success: boolean;
        timestamp: number;
    }>;
}

export interface PlanPattern {
    id: string;
    steps: string[];
    stats: {
        successCount: number;
        failureCount: number;
        contexts: Set<string>;
    };
    transitions: Array<{
        from: string;
        to: string;
        successRate: number;
        commonIssues: string[];
    }>;
}

export interface LearningMemory {
    corrections: Array<{
        errorType: 'syntax' | 'semantic' | 'dependency' | 'memory' | 'impact';
        context: {
            file: string;
            errorLocation: CodeLocation;
            codeSnippet: string;
            relatedSymbols: string[];
        };
        attempts: Array<{
            fix: ModelFileOperation;
            success: boolean;
            validationScore: number;
            timestamp: string;
            rollbackRequired: boolean;
        }>;
        patterns: {
            successfulApproaches: Array<{
                pattern: string;
                successRate: number;
                contexts: string[];
            }>;
            failedApproaches: Array<{
                pattern: string;
                failureRate: number;
                commonErrors: string[];
            }>;
        };
    }>;
}

declare module 'ollama' {
    export interface OllamaListResponse {
        models: Array<{
            name: string;
            digest: string;
            size: number;
            modified_at: string;
        }>;
    }

    export interface OllamaChatOptions {
        model: string;
        messages: Array<{
            role: string;
            content: string;
            images?: string[];
        }>;
        stream?: boolean;
        options?: {
            num_gpu?: number;
            num_thread?: number;
            batch_size?: number;
            context_length?: number;
            keep_alive?: number;
        };
    }

    export function list(): Promise<OllamaListResponse>;
    export function chat(options: OllamaChatOptions): Promise<any>;
    export function pull(options: { model: string }): Promise<void>;
}