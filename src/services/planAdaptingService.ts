import * as vscode from 'vscode';
import { 
    PlanPattern,
    ExecutionPlan,
    PlanStep,
    TaskResult,
    ValidationResult
} from '../types';
import { MemoryService } from './memoryService';
import { CodeAnalysisService } from './codeAnalysisService';
import * as crypto from 'crypto';

export class PlanAdaptingService {
    private planPatterns: Map<string, PlanPattern> = new Map();
    private outputChannel: vscode.OutputChannel;
    private readonly MIN_SIMILARITY_THRESHOLD = 0.7;

    constructor(
        private memoryService: MemoryService,
        private codeAnalysisService: CodeAnalysisService
    ) {
        this.outputChannel = vscode.window.createOutputChannel('Plan Adapting');
    }

    async learnFromPlanExecution(plan: ExecutionPlan, success: boolean) {
        try {
            // Extract step patterns from the plan
            const stepChains = this.extractStepChains(plan);
            
            for (const chain of stepChains) {
                const patternId = this.generatePatternId(chain);
                const existingPattern = this.planPatterns.get(patternId);

                if (existingPattern) {
                    this.updateExistingPattern(existingPattern, plan, success);
                } else {
                    const newPattern = this.createNewPattern(chain, plan, success);
                    this.planPatterns.set(patternId, newPattern);
                }
            }

            // Learn from transitions
            await this.learnFromTransitions(plan);
        } catch (error) {
            this.outputChannel.appendLine(`Error learning from plan execution: ${error}`);
        }
    }

    async suggestPlanModifications(plan: ExecutionPlan): Promise<{
        modifications: Array<{
            type: 'reorder' | 'insert' | 'remove' | 'modify';
            step?: PlanStep;
            reason: string;
            confidence: number;
        }>;
        risks: Array<{
            type: string;
            description: string;
            severity: 'low' | 'medium' | 'high';
        }>;
    }> {
        const modifications: Array<{
            type: 'reorder' | 'insert' | 'remove' | 'modify';
            step?: PlanStep;
            reason: string;
            confidence: number;
        }> = [];

        const risks: Array<{
            type: string;
            description: string;
            severity: 'low' | 'medium' | 'high';
        }> = [];

        try {
            // Analyze current plan against known patterns
            const similarPatterns = await this.findSimilarPatterns(plan);
            
            // Check for risky transitions
            const transitionRisks = this.identifyRiskyTransitions(plan);
            risks.push(...transitionRisks);

            // Look for potential improvements based on successful patterns
            for (const pattern of similarPatterns) {
                const suggestions = await this.generateSuggestionsFromPattern(pattern, plan);
                modifications.push(...suggestions);
            }

            // Check for known problematic step sequences
            const sequenceRisks = this.checkForProblematicSequences(plan);
            risks.push(...sequenceRisks);

            return { 
                modifications: this.rankModifications(modifications),
                risks: this.prioritizeRisks(risks)
            };
        } catch (error) {
            this.outputChannel.appendLine(`Error suggesting plan modifications: ${error}`);
            return { modifications: [], risks: [] };
        }
    }

    private extractStepChains(plan: ExecutionPlan): Array<PlanStep[]> {
        const chains: Array<PlanStep[]> = [];
        const steps = plan.steps;

        // Extract full plan as one chain
        chains.push([...steps]);

        // Extract smaller chains (e.g., 2-3 steps) for more granular patterns
        for (let i = 0; i < steps.length - 1; i++) {
            chains.push([steps[i], steps[i + 1]]);
            if (i < steps.length - 2) {
                chains.push([steps[i], steps[i + 1], steps[i + 2]]);
            }
        }

        return chains;
    }

    private generatePatternId(steps: PlanStep[]): string {
        const hash = crypto.createHash('sha256');
        const stepSignature = steps.map(s => `${s.type}:${s.description}`).join('|');
        hash.update(stepSignature);
        return hash.digest('hex').substring(0, 16);
    }

    private updateExistingPattern(pattern: PlanPattern, plan: ExecutionPlan, success: boolean) {
        // Update success/failure counts
        if (success) {
            pattern.stats.successCount++;
        } else {
            pattern.stats.failureCount++;
        }

        // Add context
        pattern.stats.contexts.add(this.getContextSignature(plan));

        // Update transition statistics
        this.updateTransitionStats(pattern, plan, success);
    }

    private createNewPattern(steps: PlanStep[], plan: ExecutionPlan, success: boolean): PlanPattern {
        return {
            id: this.generatePatternId(steps),
            steps: steps.map(s => s.id),
            stats: {
                successCount: success ? 1 : 0,
                failureCount: success ? 0 : 1,
                contexts: new Set([this.getContextSignature(plan)])
            },
            transitions: this.analyzeTransitions(steps)
        };
    }

    private async learnFromTransitions(plan: ExecutionPlan) {
        const steps = plan.steps;
        for (let i = 0; i < steps.length - 1; i++) {
            const currentStep = steps[i];
            const nextStep = steps[i + 1];

            // Analyze the transition
            const transitionSuccess = currentStep.status === 'completed' && 
                                    nextStep.status !== 'failed';

            // Store transition data
            await this.storeTransitionData(currentStep, nextStep, transitionSuccess);
        }
    }

    private async findSimilarPatterns(plan: ExecutionPlan): Promise<PlanPattern[]> {
        const similarPatterns: Array<{pattern: PlanPattern; similarity: number}> = [];

        for (const pattern of this.planPatterns.values()) {
            const similarity = await this.calculatePatternSimilarity(pattern, plan);
            if (similarity >= this.MIN_SIMILARITY_THRESHOLD) {
                similarPatterns.push({ pattern, similarity });
            }
        }

        return similarPatterns
            .sort((a, b) => b.similarity - a.similarity)
            .map(p => p.pattern);
    }

    async generateSuggestionsFromPattern(
        pattern: PlanPattern,
        currentPlan: ExecutionPlan
    ): Promise<Array<{
        type: 'reorder' | 'insert' | 'remove' | 'modify';
        step?: PlanStep;
        reason: string;
        confidence: number;
    }>> {
        const suggestions: Array<{
            type: 'reorder' | 'insert' | 'remove' | 'modify';
            step?: PlanStep;
            reason: string;
            confidence: number;
        }> = [];
        const successRate = this.calculatePatternSuccessRate(pattern);

        // Look for missing successful steps
        const missingSteps = this.findMissingSteps(pattern, currentPlan);
        for (const step of missingSteps) {
            suggestions.push({
                type: 'insert',
                step,
                reason: `This step was present in ${pattern.stats.successCount} successful executions`,
                confidence: successRate
            });
        }

        // Look for potentially problematic steps
        const problematicSteps = this.findProblematicSteps(pattern, currentPlan);
        for (const step of problematicSteps) {
            suggestions.push({
                type: 'remove',
                step,
                reason: `This step was associated with ${pattern.stats.failureCount} failures`,
                confidence: 1 - successRate
            });
        }

        // Suggest reordering if beneficial
        const reorderSuggestions = this.generateReorderSuggestions(pattern, currentPlan);
        suggestions.push(...reorderSuggestions);

        return suggestions;
    }

    private identifyRiskyTransitions(plan: ExecutionPlan): Array<{
        type: string;
        description: string;
        severity: 'low' | 'medium' | 'high';
    }> {
        const risks: Array<{
            type: string;
            description: string;
            severity: 'low' | 'medium' | 'high';
        }> = [];
        const steps = plan.steps;

        for (let i = 0; i < steps.length - 1; i++) {
            const currentStep = steps[i];
            const nextStep = steps[i + 1];

            // Check transition history
            const transitionStats = this.getTransitionStats(currentStep, nextStep);
            if (transitionStats.failureRate > 0.3) {
                risks.push({
                    type: 'risky_transition',
                    description: `Transition from ${currentStep.type} to ${nextStep.type} has a ${Math.round(transitionStats.failureRate * 100)}% failure rate`,
                    severity: this.calculateRiskSeverity(transitionStats.failureRate)
                });
            }
        }

        return risks;
    }

    private calculatePatternSimilarity(pattern: PlanPattern, plan: ExecutionPlan): number {
        let score = 0;
        let maxScore = 0;

        // Compare step types and sequences
        const stepTypeMatches = this.compareStepSequences(
            pattern.steps,
            plan.steps.map(s => s.id)
        );
        score += stepTypeMatches * 2;
        maxScore += pattern.steps.length * 2;

        // Compare contexts
        const contextSimilarity = this.compareContexts(
            pattern.stats.contexts,
            this.getContextSignature(plan)
        );
        score += contextSimilarity;
        maxScore += 1;

        return score / maxScore;
    }

    private compareStepSequences(seq1: string[], seq2: string[]): number {
        let matches = 0;
        const len = Math.min(seq1.length, seq2.length);

        for (let i = 0; i < len; i++) {
            if (seq1[i] === seq2[i]) matches++;
        }

        return matches;
    }

    private compareContexts(knownContexts: Set<string>, currentContext: string): number {
        if (knownContexts.has(currentContext)) return 1;

        let maxSimilarity = 0;
        for (const context of knownContexts) {
            const similarity = this.calculateContextSimilarity(context, currentContext);
            maxSimilarity = Math.max(maxSimilarity, similarity);
        }

        return maxSimilarity;
    }

    private calculateContextSimilarity(context1: string, context2: string): number {
        // Simple Jaccard similarity for now
        const tokens1 = new Set(context1.split('_'));
        const tokens2 = new Set(context2.split('_'));
        const intersection = new Set([...tokens1].filter(x => tokens2.has(x)));
        const union = new Set([...tokens1, ...tokens2]);
        return intersection.size / union.size;
    }

    private getContextSignature(plan: ExecutionPlan): string {
        return `${plan.objective}_${plan.steps.map(s => s.type).join('_')}`;
    }

    private calculateRiskSeverity(failureRate: number): 'low' | 'medium' | 'high' {
        if (failureRate > 0.7) return 'high';
        if (failureRate > 0.4) return 'medium';
        return 'low';
    }

    private async storeTransitionData(
        fromStep: PlanStep,
        toStep: PlanStep,
        success: boolean
    ) {
        // Store transition statistics for future reference
        const key = `${fromStep.type}_${toStep.type}`;
        // Implementation details would depend on storage mechanism
    }

    private getTransitionStats(fromStep: PlanStep, toStep: PlanStep): {
        successCount: number;
        failureCount: number;
        failureRate: number;
    } {
        // Placeholder implementation
        return {
            successCount: 1,
            failureCount: 0,
            failureRate: 0
        };
    }

    private calculatePatternSuccessRate(pattern: PlanPattern): number {
        const total = pattern.stats.successCount + pattern.stats.failureCount;
        return total > 0 ? pattern.stats.successCount / total : 0;
    }

    private findMissingSteps(pattern: PlanPattern, plan: ExecutionPlan): PlanStep[] {
        // Implementation to find steps present in successful pattern but missing in current plan
        return [];
    }

    private findProblematicSteps(pattern: PlanPattern, plan: ExecutionPlan): PlanStep[] {
        // Implementation to identify steps that often lead to failures
        return [];
    }

    private generateReorderSuggestions(pattern: PlanPattern, plan: ExecutionPlan): Array<{
        type: 'reorder';
        step?: PlanStep;
        reason: string;
        confidence: number;
    }> {
        // Implementation to suggest beneficial step reordering
        return [];
    }

    private checkForProblematicSequences(plan: ExecutionPlan): Array<{
        type: string;
        description: string;
        severity: 'low' | 'medium' | 'high';
    }> {
        // Implementation to identify known problematic step sequences
        return [];
    }

    private rankModifications(modifications: Array<{
        type: 'reorder' | 'insert' | 'remove' | 'modify';
        step?: PlanStep;
        reason: string;
        confidence: number;
    }>): typeof modifications {
        return modifications.sort((a, b) => b.confidence - a.confidence);
    }

    private prioritizeRisks(risks: Array<{
        type: string;
        description: string;
        severity: 'low' | 'medium' | 'high';
    }>): typeof risks {
        const severityScore = {
            'high': 3,
            'medium': 2,
            'low': 1
        };
        return risks.sort((a, b) => severityScore[b.severity] - severityScore[a.severity]);
    }

    private updateTransitionStats(pattern: PlanPattern, plan: ExecutionPlan, success: boolean) {
        // Implementation to update transition statistics
    }

    private analyzeTransitions(steps: PlanStep[]): Array<{
        from: string;
        to: string;
        successRate: number;
        commonIssues: string[];
    }> {
        // Implementation to analyze transitions between steps
        return [];
    }
}
