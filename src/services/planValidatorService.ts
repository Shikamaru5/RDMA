import * as vscode from 'vscode';
import { 
    PlanValidationContext, 
    PlanValidationResult, 
    PlanStep, 
    ExecutionPlan,
    CodeContext
} from '../types';
import { MemoryService } from './memoryService';
import { CodeAnalysisService } from './codeAnalysisService';
import { FileSystemService } from './fileSystemService';
import { OllamaService } from './ollamaService';
import { AutoCorrectService } from './autoCorrectService';
import { ModelCoordinator } from './modelCoordinator';

export class PlanValidatorService {
    private outputChannel: vscode.OutputChannel;
    private autoCorrectService: AutoCorrectService;

    constructor(
        private memoryService: MemoryService,
        private codeAnalysisService: CodeAnalysisService,
        private fileSystemService: FileSystemService,
        private ollamaService: OllamaService,
        private modelCoordinator: ModelCoordinator
    ) {
        this.outputChannel = vscode.window.createOutputChannel('Plan Validator');
        this.autoCorrectService = new AutoCorrectService(
            ollamaService,
            codeAnalysisService,
            fileSystemService,
            memoryService,
            modelCoordinator
        );
    }

    async validatePlanStep(context: PlanValidationContext): Promise<PlanValidationResult> {
        const validationResult: PlanValidationResult = {
            isValid: true,
            requiresPlanRevision: false
        };

        try {
            // 1. Validate step against objective
            const objectiveAlignment = await this.validateObjectiveAlignment(context);
            if (!objectiveAlignment.isValid) {
                // Attempt auto-correction before returning error
                const correctionResult = await this.attemptAutoCorrect(context, objectiveAlignment);
                if (correctionResult.success) {
                    // Re-validate after correction
                    return await this.validatePlanStep(context);
                }
                return {
                    ...objectiveAlignment,
                    requiresPlanRevision: true,
                    suggestedRevisions: [{
                        type: 'modify',
                        step: context.currentStep,
                        reason: 'Step does not align with plan objective'
                    }]
                };
            }

            // 2. Validate code changes
            if (context.currentStep.type === 'code') {
                const codeValidation = await this.validateCodeChanges(context);
                if (!codeValidation.isValid) {
                    // Attempt auto-correction for code issues
                    const correctionResult = await this.attemptAutoCorrect(context, codeValidation);
                    if (correctionResult.success) {
                        // Re-validate after correction
                        return await this.validatePlanStep(context);
                    }
                    return {
                        ...codeValidation,
                        requiresPlanRevision: true,
                        suggestedRevisions: [{
                            type: 'modify',
                            step: context.currentStep,
                            reason: 'Code changes validation failed'
                        }]
                    };
                }
            }

            // 3. Check for dependency conflicts
            const dependencyCheck = await this.validateDependencies(context);
            if (!dependencyCheck.isValid) {
                // Attempt auto-correction for dependency issues
                const correctionResult = await this.attemptAutoCorrect(context, dependencyCheck);
                if (correctionResult.success) {
                    // Re-validate after correction
                    return await this.validatePlanStep(context);
                }
                return {
                    ...dependencyCheck,
                    requiresPlanRevision: true,
                    suggestedRevisions: [{
                        type: 'insert',
                        reason: 'Missing dependency resolution step'
                    }]
                };
            }

            // 4. Validate against memory context
            const memoryValidation = await this.validateAgainstMemory(context);
            if (!memoryValidation.isValid) {
                // Attempt auto-correction for memory conflicts
                const correctionResult = await this.attemptAutoCorrect(context, memoryValidation);
                if (correctionResult.success) {
                    // Re-validate after correction
                    return await this.validatePlanStep(context);
                }
                return {
                    ...memoryValidation,
                    requiresPlanRevision: true
                };
            }

            return validationResult;

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                isValid: false,
                requiresPlanRevision: true,
                errors: [`Validation error: ${errorMessage}`],
                suggestedRevisions: [{
                    type: 'modify',
                    step: context.currentStep,
                    reason: `Error during validation: ${errorMessage}`
                }]
            };
        }
    }

    private async validateObjectiveAlignment(context: PlanValidationContext): Promise<PlanValidationResult> {
        // Compare step's purpose with overall objective
        const { objective, currentStep } = context;
        
        // Get recent memory context to check alignment
        const recentContext = await this.memoryService.getRecentContext();
        
        // Check if current step aligns with objective and previous steps
        const stepDescription = currentStep.description.toLowerCase();
        const objectiveKeywords = objective.toLowerCase().split(' ');
        
        const alignmentScore = objectiveKeywords.filter(keyword => 
            stepDescription.includes(keyword)
        ).length / objectiveKeywords.length;

        if (alignmentScore < 0.3) { // Threshold for alignment
            return {
                isValid: false,
                requiresPlanRevision: true,
                errors: ['Step does not align well with the plan objective'],
                reason: 'Low objective alignment score'
            };
        }

        return { isValid: true, requiresPlanRevision: false };
    }

    private async validateCodeChanges(context: PlanValidationContext): Promise<PlanValidationResult> {
        const { memory, currentStep } = context;
        
        // Get all code changes from memory
        const codeChanges = memory.codeChanges;
        
        // Check for syntax errors
        const errors: string[] = [];
        for (const change of codeChanges) {
            try {
                const analysisResult = await this.ollamaService.analyzeCode(
                    change.diff,
                    'Analyze this code for syntax errors and potential issues'
                );
                const analysis = JSON.parse(analysisResult);
                if (analysis.analysis?.errors?.length > 0) {
                    errors.push(...analysis.analysis.errors);
                }
            } catch (error: any) {
                errors.push(`Analysis error: ${error.message}`);
            }
        }

        if (errors.length > 0) {
            return {
                isValid: false,
                requiresPlanRevision: false,
                errors,
                reason: 'Code changes contain syntax errors'
            };
        }

        // Validate impact on other files
        const impactAnalysis = await this.validateCodeImpact(codeChanges);
        if (!impactAnalysis.isValid) {
            return impactAnalysis;
        }

        return { isValid: true, requiresPlanRevision: false };
    }

    private async validateDependencies(context: PlanValidationContext): Promise<PlanValidationResult> {
        const { currentStep, previousSteps } = context;
        
        // Check if all dependencies are satisfied
        if (currentStep.dependencies) {
            for (const depId of currentStep.dependencies) {
                const depStep = previousSteps.find(step => step.id === depId);
                if (!depStep || depStep.status !== 'completed') {
                    return {
                        isValid: false,
                        requiresPlanRevision: true,
                        errors: [`Dependency ${depId} not satisfied`],
                        reason: 'Missing or incomplete dependencies'
                    };
                }
            }
        }

        return { isValid: true, requiresPlanRevision: false };
    }

    private async validateAgainstMemory(context: PlanValidationContext): Promise<PlanValidationResult> {
        const { memory, currentStep } = context;
        
        // Check if current step conflicts with previous analyses
        const conflictingAnalyses = memory.analysisResults.filter(analysis => {
            // Look for analyses that contradict current step
            return analysis.analysis.toLowerCase().includes('error') ||
                   analysis.analysis.toLowerCase().includes('conflict');
        });

        if (conflictingAnalyses.length > 0) {
            return {
                isValid: false,
                requiresPlanRevision: true,
                errors: conflictingAnalyses.map(a => `Conflicts with previous analysis: ${a.analysis}`),
                reason: 'Conflicts with previous analyses found'
            };
        }

        return { isValid: true, requiresPlanRevision: false };
    }

    private async validateCodeImpact(codeChanges: Array<{path: string; diff: string}>): Promise<PlanValidationResult> {
        const impactedFiles = new Set<string>();
        
        for (const change of codeChanges) {
            // Create a code proposal to analyze impact
            const proposal = await this.codeAnalysisService.proposeChanges(
                change.path,
                [{
                    type: 'modification',
                    startLine: 0, // We'll need to parse the diff to get actual lines
                    endLine: 0,
                    newContent: change.diff
                }]
            );
            
            // Add impacted files from the proposal
            proposal.impact.dependencies.forEach(file => impactedFiles.add(file));
        }

        // Check each impacted file for potential issues
        const errors: string[] = [];
        for (const file of impactedFiles) {
            try {
                const fileContent = await this.fileSystemService.readFile(file);
                const analysisResult = await this.ollamaService.analyzeCode(
                    fileContent,
                    'Analyze this code for potential issues after dependent file changes'
                );
                const analysis = JSON.parse(analysisResult);
                if (analysis.analysis?.errors?.length > 0) {
                    errors.push(`Impact on ${file}: ${analysis.analysis.errors.join(', ')}`);
                }
            } catch (error: any) {
                errors.push(`Error analyzing ${file}: ${error.message}`);
            }
        }

        if (errors.length > 0) {
            return {
                isValid: false,
                requiresPlanRevision: false,
                errors,
                reason: 'Changes cause issues in dependent files',
                impactedFiles: Array.from(impactedFiles)
            };
        }

        return { 
            isValid: true, 
            requiresPlanRevision: false,
            impactedFiles: Array.from(impactedFiles)
        };
    }

    async attemptAutoCorrect(context: PlanValidationContext, error: PlanValidationResult): Promise<{
        success: boolean;
        appliedCorrections: any[];
    }> {
        try {
            // Generate potential corrections
            const corrections = await this.autoCorrectService.generateCorrections(error);
            const appliedCorrections: any[] = [];

            // Try each correction until one works
            for (const correction of corrections) {
                const success = await this.autoCorrectService.applyCorrection(correction);
                if (success) {
                    appliedCorrections.push(correction);
                    // Log successful correction
                    this.outputChannel.appendLine(`Successfully applied correction: ${correction.errorType}`);
                    return { success: true, appliedCorrections };
                }
            }

            // If we get here, no corrections worked
            return { success: false, appliedCorrections };
        } catch (e) {
            this.outputChannel.appendLine(`Error in auto-correction attempt: ${e}`);
            return { success: false, appliedCorrections: [] };
        }
    }
}