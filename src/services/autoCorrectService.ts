import * as vscode from 'vscode';
import { 
    ErrorCorrection,
    ValidationResult,
    ModelFileOperation,
    CodeAnalysisResult,
    PlanValidationContext,
    ModelResponse
} from '../types';
import { OllamaService } from './ollamaService';
import { CodeAnalysisService } from './codeAnalysisService';
import { FileSystemService } from './fileSystemService';
import { MemoryService } from './memoryService';
import { ModelCoordinator } from './modelCoordinator';
import * as path from 'path';
import * as fs from 'fs';
import { PatternLearningService } from './patternLearningService';
import { ThresholdManager } from './thresholdManager';

export class AutoCorrectService {
    private outputChannel: vscode.OutputChannel;
    private correctionHistory: Map<string, ErrorCorrection[]> = new Map();
    private patternLearning: PatternLearningService;
    private thresholdManager: ThresholdManager;

    constructor(
        private ollamaService: OllamaService,
        private codeAnalysisService: CodeAnalysisService,
        private fileSystemService: FileSystemService,
        private memoryService: MemoryService,
        private modelCoordinator: ModelCoordinator
    ) {
        this.outputChannel = vscode.window.createOutputChannel('Auto Correct');
        this.patternLearning = new PatternLearningService(codeAnalysisService, fileSystemService);
        this.thresholdManager = new ThresholdManager();
    }

    async generateCorrections(error: ValidationResult): Promise<ErrorCorrection[]> {
        try {
            // Get corrections from pattern-based learning
            const patternBasedFixes = await this.patternLearning.suggestFixesBasedOnPatterns(error);
            
            // Get standard corrections through normal process
            const standardFixes = await this.generateStandardCorrections(error);
            
            // Combine and rank fixes
            const allFixes = await this.rankAndCombineFixes(
                [...patternBasedFixes, ...standardFixes],
                error
            );

            // Store in correction history
            const errorKey = this.generateErrorKey(error);
            this.correctionHistory.set(errorKey, allFixes);
            
            return allFixes;
        } catch (e) {
            this.outputChannel.appendLine(`Error generating corrections: ${e}`);
            return [];
        }
    }

    private async generateStandardCorrections(error: ValidationResult): Promise<ErrorCorrection[]> {
        const corrections: ErrorCorrection[] = [];
        
        try {
            // Classify error and determine severity
            const errorType = this.classifyError(error);
            const severity = this.assessSeverity(error);
            
            // Generate context for the error
            const context = await this.buildErrorContext(error);
            
            // Generate potential fixes based on error type
            const suggestedFixes = await this.generatePotentialFixes(errorType, context, error);
            
            if (suggestedFixes.length > 0) {
                corrections.push({
                    errorType,
                    severity,
                    context,
                    suggestedFixes
                });
            }
        } catch (e) {
            this.outputChannel.appendLine(`Error in standard correction generation: ${e}`);
        }
        
        return corrections;
    }

    async applyCorrection(correction: ErrorCorrection): Promise<boolean> {
        try {
            // Get dynamic threshold for this type of correction
            const threshold = this.thresholdManager.getThreshold(
                correction.errorType,
                this.contextToString(correction.context)
            );
            
            // Sort fixes by confidence and filter by threshold
            const viableFixes = correction.suggestedFixes
                .filter(fix => fix.confidence >= threshold)
                .sort((a, b) => b.confidence - a.confidence);
            
            // Try applying fixes in order of confidence
            for (const fix of viableFixes) {
                try {
                    // Apply each change in the fix
                    for (const change of fix.changes) {
                        await this.applyFileOperation(change);
                    }
                    
                    // Verify the correction
                    const verificationResult = await this.verifyCorrection(correction);
                    if (verificationResult.isValid) {
                        // Learn from successful correction
                        await this.patternLearning.learnFromCorrection(correction, true);
                        await this.thresholdManager.adjustThreshold(
                            correction.errorType,
                            this.contextToString(correction.context),
                            true
                        );
                        await this.memoryService.addCorrection(correction, true);
                        return true;
                    }
                    
                    // If verification fails, rollback and learn from failure
                    await this.rollbackCorrection(correction);
                    await this.patternLearning.learnFromCorrection(correction, false);
                    await this.thresholdManager.adjustThreshold(
                        correction.errorType,
                        this.contextToString(correction.context),
                        false
                    );
                    await this.memoryService.addCorrection(correction, false);
                } catch (fixError) {
                    this.outputChannel.appendLine(`Error applying fix: ${fixError}`);
                    await this.rollbackCorrection(correction);
                }
            }
            
            return false;
        } catch (e) {
            this.outputChannel.appendLine(`Error in correction application: ${e}`);
            return false;
        }
    }

    private async rankAndCombineFixes(
        fixes: ErrorCorrection[],
        error: ValidationResult
    ): Promise<ErrorCorrection[]> {
        try {
            // Group fixes by similarity
            const groupedFixes = this.groupSimilarFixes(fixes);
            
            // Score each group
            const scoredGroups = await Promise.all(
                groupedFixes.map(async group => ({
                    fixes: group,
                    score: await this.calculateFixGroupScore(group, error)
                }))
            );
            
            // Sort by score and flatten
            return scoredGroups
                .sort((a, b) => b.score - a.score)
                .map(group => group.fixes)
                .flat();
        } catch (error) {
            this.outputChannel.appendLine(`Error ranking fixes: ${error}`);
            return fixes;
        }
    }

    private groupSimilarFixes(fixes: ErrorCorrection[]): ErrorCorrection[][] {
        // Group fixes that are similar in their approach
        const groups: ErrorCorrection[][] = [];
        
        for (const fix of fixes) {
            let addedToGroup = false;
            
            for (const group of groups) {
                if (this.areFixesSimilar(group[0], fix)) {
                    group.push(fix);
                    addedToGroup = true;
                    break;
                }
            }
            
            if (!addedToGroup) {
                groups.push([fix]);
            }
        }
        
        return groups;
    }

    private async calculateFixGroupScore(
        group: ErrorCorrection[],
        error: ValidationResult
    ): Promise<number> {
        try {
            let score = 0;
            
            for (const fix of group) {
                // Base confidence score
                score += fix.suggestedFixes[0].confidence;
                
                // Historical success rate from pattern learning
                const historicalSuccess = await this.getHistoricalSuccessRate(fix);
                score += historicalSuccess * 2;
                
                // Context similarity score (if error has location info)
                if (fix.context && fix.context.file) {
                    const contextScore = this.calculateContextSimilarity(
                        fix.context,
                        { file: fix.context.file } // Use minimal context if error doesn't have full context
                    );
                    score += contextScore;
                }
                
                // Impact assessment score
                const impactScore = await this.assessImpact(fix);
                score += impactScore;
            }
            
            return score / group.length;
        } catch (error) {
            this.outputChannel.appendLine(`Error calculating fix group score: ${error}`);
            return 0;
        }
    }

    private contextToString(context: any): string {
        return `${context.file}:${context.line || ''}`;
    }

    private areFixesSimilar(fix1: ErrorCorrection, fix2: ErrorCorrection): boolean {
        // If error types are different, fixes are not similar
        if (fix1.errorType !== fix2.errorType) return false;

        // Compare the changes in the fixes
        const changes1 = fix1.suggestedFixes[0]?.changes || [];
        const changes2 = fix2.suggestedFixes[0]?.changes || [];

        // If number of changes is very different, fixes are not similar
        if (Math.abs(changes1.length - changes2.length) > 1) return false;

        // Compare each change operation
        let similarChanges = 0;
        for (const change1 of changes1) {
            for (const change2 of changes2) {
                if (this.areOperationsSimilar(change1, change2)) {
                    similarChanges++;
                    break;
                }
            }
        }

        // Consider fixes similar if most changes are similar
        return similarChanges >= Math.min(changes1.length, changes2.length) * 0.7;
    }

    private areOperationsSimilar(op1: ModelFileOperation, op2: ModelFileOperation): boolean {
        // Must be same operation type
        if (op1.type !== op2.type) return false;

        // For file operations, compare paths
        if (op1.filePath && op2.filePath && op1.filePath !== op2.filePath) return false;

        // For edits, compare the changes
        if (op1.type === 'edit' && op2.type === 'edit') {
            const edits1 = op1.edits || [];
            const edits2 = op2.edits || [];

            // Compare edit locations and content similarity
            return edits1.some(edit1 => 
                edits2.some(edit2 => 
                    Math.abs(edit1.startLine - edit2.startLine) <= 2 && // Within 2 lines
                    this.calculateTextSimilarity(edit1.newContent, edit2.newContent) > 0.7
                )
            );
        }

        // For create operations, compare content similarity
        if (op1.type === 'create' && op2.type === 'create') {
            return this.calculateTextSimilarity(op1.content || '', op2.content || '') > 0.7;
        }

        return true; // For other operations (delete, createDirectory)
    }

    private calculateTextSimilarity(text1: string, text2: string): number {
        if (!text1 || !text2) return 0;
        
        // Normalize and split into tokens
        const tokens1 = new Set(text1.toLowerCase().split(/\s+/));
        const tokens2 = new Set(text2.toLowerCase().split(/\s+/));
        
        // Calculate Jaccard similarity
        const intersection = new Set([...tokens1].filter(x => tokens2.has(x)));
        const union = new Set([...tokens1, ...tokens2]);
        
        return intersection.size / union.size;
    }

    private async getHistoricalSuccessRate(fix: ErrorCorrection): Promise<number> {
        try {
            // Get historical corrections from memory service
            const history: ErrorCorrection[] = await this.memoryService.getCorrections(fix.errorType);
            if (!history || history.length === 0) return 0.5; // Default if no history
    
            // Filter corrections that are similar to current fix
            const similarCorrections = history.filter((historicFix: ErrorCorrection) => 
                this.areFixesSimilar(historicFix, fix)
            );
    
            if (similarCorrections.length === 0) return 0.5; // Default if no similar corrections
    
            // Calculate success rate from similar corrections
            const successCount = similarCorrections.filter((correction: ErrorCorrection) => 
                correction.suggestedFixes.some((suggestedFix: { confidence: number }) => 
                    suggestedFix.confidence > 0.8
                )
            ).length;
    
            return successCount / similarCorrections.length;
        } catch (error) {
            this.outputChannel.appendLine(`Error getting historical success rate: ${error}`);
            return 0.5; // Default on error
        }
    }

    private calculateContextSimilarity(context1: any, context2: any): number {
        if (!context1 || !context2) return 0;
        
        let score = 0;
        let maxScore = 0;
        
        // Compare files
        if (context1.file && context2.file) {
            score += context1.file === context2.file ? 1 : 0;
            maxScore += 1;
        }
        
        // Compare lines if available
        if (context1.line !== undefined && context2.line !== undefined) {
            // Score based on line proximity
            const lineDiff = Math.abs(context1.line - context2.line);
            score += lineDiff === 0 ? 1 : 1 / (lineDiff + 1);
            maxScore += 1;
        }
        
        // Compare related symbols if available
        if (context1.relatedSymbols && context2.relatedSymbols) {
            const symbols1 = new Set(context1.relatedSymbols);
            const symbols2 = new Set(context2.relatedSymbols);
            const intersection = new Set([...symbols1].filter(x => symbols2.has(x)));
            const union = new Set([...symbols1, ...symbols2]);
            
            if (union.size > 0) {
                score += intersection.size / union.size;
                maxScore += 1;
            }
        }
        
        return maxScore > 0 ? score / maxScore : 0;
    }

    private async assessImpact(fix: ErrorCorrection): Promise<number> {
        // Assess potential impact of the fix
        return 0.5; // Placeholder implementation
    }

    private classifyError(error: ValidationResult): ErrorCorrection['errorType'] {
        if (error.errors?.some(e => e.includes('syntax'))) {
            return 'syntax';
        }
        if (error.errors?.some(e => e.includes('dependency'))) {
            return 'dependency';
        }
        if (error.errors?.some(e => e.includes('memory'))) {
            return 'memory';
        }
        if (error.errors?.some(e => e.includes('impact'))) {
            return 'impact';
        }
        return 'semantic';
    }

    private assessSeverity(error: ValidationResult): ErrorCorrection['severity'] {
        // Assess based on error pattern and impact
        if (error.errors?.some(e => e.includes('critical') || e.includes('crash'))) {
            return 'critical';
        }
        if (error.errors?.some(e => e.includes('high'))) {
            return 'high';
        }
        if (error.errors?.some(e => e.includes('medium'))) {
            return 'medium';
        }
        return 'low';
    }

    private async buildErrorContext(error: ValidationResult): Promise<ErrorCorrection['context']> {
        const context: ErrorCorrection['context'] = {};
        
        // Extract file path and line number from error messages if available
        for (const msg of error.errors || []) {
            const fileMatch = msg.match(/file[:\s]+([^\s]+)/i);
            const lineMatch = msg.match(/line[:\s]+(\d+)/i);
            
            if (fileMatch) {
                context.file = fileMatch[1];
            }
            if (lineMatch) {
                context.line = parseInt(lineMatch[1], 10);
            }
        }
        
        // If we have file and line, get the code
        if (context.file && context.line !== undefined) {
            const fileContent = await this.fileSystemService.readFile(context.file);
            const lines = fileContent.split('\n');
            context.code = lines[context.line - 1];
        }
        
        // Get related symbols from code analysis
        if (context.file) {
            const analysis = await this.fileSystemService.analyzeFile(context.file);
            if (analysis.languageAnalysis?.structure) {
                context.relatedSymbols = analysis.languageAnalysis.structure.map(s => s.name);
            }
        }
        
        return context;
    }

    private async generatePotentialFixes(
        errorType: ErrorCorrection['errorType'],
        context: ErrorCorrection['context'],
        error: ValidationResult
    ): Promise<ErrorCorrection['suggestedFixes']> {
        const fixes: ErrorCorrection['suggestedFixes'] = [];
        
        // Use Ollama to generate potential fixes
        const prompt = this.buildFixGenerationPrompt(errorType, context, error);
        const response = await this.ollamaService.generateResponse(prompt);
        
        try {
            const suggestedChanges = JSON.parse(response);
            if (Array.isArray(suggestedChanges)) {
                for (const change of suggestedChanges) {
                    fixes.push({
                        description: change.description,
                        changes: this.convertToFileOperations(change.fixes),
                        confidence: this.calculateConfidence(change, context)
                    });
                }
            }
        } catch (e) {
            this.outputChannel.appendLine(`Error parsing fix suggestions: ${e}`);
        }
        
        return fixes;
    }

    private buildFixGenerationPrompt(
        errorType: ErrorCorrection['errorType'],
        context: ErrorCorrection['context'],
        error: ValidationResult
    ): string {
        return `Generate fixes for the following error:
            Type: ${errorType}
            File: ${context.file}
            Line: ${context.line}
            Code: ${context.code}
            Error: ${error.errors?.join('\n')}
            
            Provide fixes in the following JSON format:
            [
                {
                    "description": "Fix description",
                    "fixes": [
                        {
                            "type": "edit",
                            "file": "path/to/file",
                            "changes": [
                                {
                                    "line": number,
                                    "content": "new content"
                                }
                            ]
                        }
                    ]
                }
            ]`;
    }

    private convertToFileOperations(fixes: any[]): ModelFileOperation[] {
        return fixes.map(fix => ({
            type: fix.type,
            filePath: fix.file,
            edits: fix.changes.map((change: any) => ({
                startLine: change.line,
                endLine: change.line,
                newContent: change.content
            }))
        }));
    }

    private calculateConfidence(change: any, context: ErrorCorrection['context']): number {
        let confidence = 0.5; // Base confidence
        
        // Increase confidence if:
        // 1. The fix is simple (few changes)
        if (change.fixes.length === 1) confidence += 0.1;
        
        // 2. The fix is localized to the error location
        if (change.fixes.some((f: any) => 
            f.file === context.file && 
            f.changes.some((c: any) => c.line === context.line)
        )) {
            confidence += 0.2;
        }
        
        // 3. The fix preserves existing code structure
        if (change.fixes.every((f: any) => f.type === 'edit')) confidence += 0.1;
        
        return Math.min(confidence, 1); // Cap at 1.0
    }

    private generateErrorKey(error: ValidationResult): string {
        return `${error.errors?.join('_')}_${Date.now()}`;
    }

    async verifyCorrection(correction: ErrorCorrection): Promise<ValidationResult> {
        // Analyze the code after correction
        if (correction.context.file) {
            const analysis = await this.fileSystemService.analyzeFile(correction.context.file);
            
            // Check for any remaining syntax errors
            if (analysis.languageAnalysis?.syntaxErrors && analysis.languageAnalysis.syntaxErrors.length > 0) {
                return {
                    isValid: false,
                    errors: analysis.languageAnalysis.syntaxErrors.map(e => `${e.message} at line ${e.line}, column ${e.column}`)
                };
            }
            
            // Verify dependencies if it was a dependency error
            if (correction.errorType === 'dependency') {
                const dependencyCheck = await this.verifyDependencies(correction);
                if (!dependencyCheck.isValid) {
                    return dependencyCheck;
                }
            }
        }
        
        return { isValid: true };
    }

    async rollbackCorrection(correction: ErrorCorrection): Promise<void> {
        try {
            // Reverse each change in the correction
            for (const fix of correction.suggestedFixes) {
                for (const change of fix.changes) {
                    await this.rollbackFileOperation(change);
                }
            }
        } catch (e) {
            this.outputChannel.appendLine(`Error in correction rollback: ${e}`);
            throw e;
        }
    }

    private async applyFileOperation(operation: ModelFileOperation): Promise<void> {
        // Store original content for potential rollback
        if (operation.type === 'edit' && operation.edits) {
            const fileContent = await fs.promises.readFile(operation.filePath!, 'utf-8');
            const lines = fileContent.split('\n');
            for (const edit of operation.edits) {
                edit.oldContent = lines.slice(edit.startLine - 1, edit.endLine).join('\n');
            }
        }

        // Create a model response with our operation
        const modelResponse: ModelResponse = {
            operations: [operation],
            explanation: 'Auto-correction operation',
            requiresValidation: true
        };
    
        // Use ModelCoordinator to execute the operation
        const result = await this.modelCoordinator.executeModelResponse(modelResponse);
        
        if (!result.success) {
            throw new Error(`Failed to apply correction: ${result.results.join(', ')}`);
        }
    }

    private async rollbackFileOperation(operation: ModelFileOperation): Promise<void> {
        if (operation.type !== 'edit' || !operation.edits) {
            return;
        }

        // Create a reverse operation using stored old content
        const reverseOperation: ModelFileOperation = {
            type: 'edit',
            filePath: operation.filePath,
            edits: operation.edits.map(edit => ({
                startLine: edit.startLine,
                endLine: edit.endLine,
                newContent: edit.oldContent || '' // Now properly typed
            }))
        };

        // Use ModelCoordinator to execute the reverse operation
        const modelResponse: ModelResponse = {
            operations: [reverseOperation],
            explanation: 'Auto-correction rollback',
            requiresValidation: true
        };

        const result = await this.modelCoordinator.executeModelResponse(modelResponse);
        
        if (!result.success) {
            throw new Error(`Failed to rollback correction: ${result.results.join(', ')}`);
        }
    }

    private async verifyDependencies(correction: ErrorCorrection): Promise<ValidationResult> {
        // Implementation depends on your dependency checking logic
        const analysis = await this.fileSystemService.analyzeFile(correction.context.file!);
        
        if (analysis.languageAnalysis?.dependencies && analysis.languageAnalysis.dependencies.length > 0) {
            const missingDeps = analysis.languageAnalysis.dependencies.filter(dep => {
                // Check if dependency exists and is accessible
                try {
                    const depPath = path.resolve(path.dirname(correction.context.file!), dep);
                    return !fs.existsSync(depPath);
                } catch {
                    return true;
                }
            });

            if (missingDeps.length > 0) {
                return {
                    isValid: false,
                    errors: [`Missing dependencies: ${missingDeps.join(', ')}`]
                };
            }
        }
        
        return { isValid: true };
    }
}
