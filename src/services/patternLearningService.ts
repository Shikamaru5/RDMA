import * as vscode from 'vscode';
import { 
    Pattern, 
    ErrorCorrection, 
    ValidationResult, 
    ModelFileOperation,
    CodeLocation
} from '../types';
import { CodeAnalysisService } from './codeAnalysisService';
import { FileSystemService } from './fileSystemService';
import * as crypto from 'crypto';

export class PatternLearningService {
    private patterns: Map<string, Pattern> = new Map();
    private outputChannel: vscode.OutputChannel;

    constructor(
        private codeAnalysisService: CodeAnalysisService,
        private fileSystemService: FileSystemService
    ) {
        this.outputChannel = vscode.window.createOutputChannel('Pattern Learning');
    }

    async learnFromCorrection(correction: ErrorCorrection, success: boolean) {
        try {
            const pattern = await this.extractPattern(correction);
            const existingPattern = this.patterns.get(pattern.id);

            if (existingPattern) {
                this.updateExistingPattern(existingPattern, correction, success);
            } else {
                this.patterns.set(pattern.id, this.initializePattern(pattern, correction, success));
            }
        } catch (error) {
            this.outputChannel.appendLine(`Error learning from correction: ${error}`);
        }
    }

    async suggestFixesBasedOnPatterns(error: ValidationResult): Promise<ErrorCorrection[]> {
        try {
            const similarPatterns = await this.findSimilarPatterns(error);
            return this.generateFixesFromPatterns(similarPatterns, error);
        } catch (error) {
            this.outputChannel.appendLine(`Error suggesting fixes: ${error}`);
            return [];
        }
    }

    private async extractPattern(correction: ErrorCorrection): Promise<Pattern> {
        const context = correction.context;
        if (!context.file) {
            throw new Error('Cannot extract pattern: file path is undefined');
        }
        if (context.line === undefined) {
            throw new Error('Cannot extract pattern: line number is undefined');
        }
        const fileContent = await this.fileSystemService.readFile(context.file);
        const codeSnippet = this.extractRelevantCodeSnippet(fileContent, context.line);
        const relatedSymbols = await this.codeAnalysisService.extractSymbols(codeSnippet);

        return {
            id: this.generatePatternId(correction, codeSnippet),
            errorType: correction.errorType,
            context: {
                file: context.file,
                errorLocation: {
                    filePath: context.file,
                    line: context.line,
                    column: 0 // Default to start of line if column is not provided
                },
                codeSnippet,
                relatedSymbols
            },
            stats: {
                successCount: 0,
                failureCount: 0,
                lastUsed: new Date().toISOString(),
                contexts: new Set()
            },
            strategies: {
                successful: [],
                failed: []
            }
        };
    }

    private generatePatternId(correction: ErrorCorrection, codeSnippet: string): string {
        const hash = crypto.createHash('sha256');
        hash.update(`${correction.errorType}:${codeSnippet}`);
        return hash.digest('hex').substring(0, 16);
    }

    private updateExistingPattern(pattern: Pattern, correction: ErrorCorrection, success: boolean) {
        // Update basic stats
        if (success) {
            pattern.stats.successCount++;
        } else {
            pattern.stats.failureCount++;
        }
        pattern.stats.lastUsed = new Date().toISOString();
        pattern.stats.contexts.add(this.contextToString(correction.context));

        // Update strategies
        if (success) {
            this.updateSuccessfulStrategy(pattern, correction);
        } else {
            this.updateFailedStrategy(pattern, correction);
        }
    }

    private updateSuccessfulStrategy(pattern: Pattern, correction: ErrorCorrection) {
        const existingStrategy = pattern.strategies.successful.find(
            s => this.areFixesSimilar(s.fixes, correction.suggestedFixes[0].changes)
        );

        if (existingStrategy) {
            existingStrategy.successRate = (
                (existingStrategy.successRate * existingStrategy.contexts.length + 1) /
                (existingStrategy.contexts.length + 1)
            );
            existingStrategy.contexts.push(this.contextToString(correction.context));
        } else {
            pattern.strategies.successful.push({
                fixes: correction.suggestedFixes[0].changes,
                successRate: 1,
                contexts: [this.contextToString(correction.context)]
            });
        }
    }

    private updateFailedStrategy(pattern: Pattern, correction: ErrorCorrection) {
        const existingStrategy = pattern.strategies.failed.find(
            s => this.areFixesSimilar(s.fixes, correction.suggestedFixes[0].changes)
        );

        if (existingStrategy) {
            existingStrategy.failureRate = (
                (existingStrategy.failureRate * existingStrategy.errors.length + 1) /
                (existingStrategy.errors.length + 1)
            );
            // Collect errors from the context
            const contextErrors = correction.context.code ? 
                [`Error in ${correction.context.file}:${correction.context.line} - ${correction.context.code}`] : 
                [];
            existingStrategy.errors.push(...contextErrors);
        } else {
            pattern.strategies.failed.push({
                fixes: correction.suggestedFixes[0].changes,
                failureRate: 1,
                errors: correction.context.code ? 
                    [`Error in ${correction.context.file}:${correction.context.line} - ${correction.context.code}`] : 
                    []
            });
        }
    }

    private async findSimilarPatterns(error: ValidationResult): Promise<Pattern[]> {
        const similarPatterns: Array<{pattern: Pattern; similarity: number}> = [];

        for (const pattern of this.patterns.values()) {
            const similarity = await this.calculatePatternSimilarity(pattern, error);
            if (similarity > 0.7) { // Threshold for similarity
                similarPatterns.push({ pattern, similarity });
            }
        }

        return similarPatterns
            .sort((a, b) => b.similarity - a.similarity)
            .map(p => p.pattern);
    }

    private async calculatePatternSimilarity(pattern: Pattern, error: ValidationResult): Promise<number> {
        let score = 0;
        let weights = 0;

        // Error type match - infer from error messages
        const errorMessages = error.errors || [];
        const inferredErrorType = this.inferErrorType(errorMessages);
        if (pattern.errorType === inferredErrorType) {
            score += 5;
        }
        weights += 5;

        // Context similarity
        if (error.impactedFiles && error.impactedFiles.length > 0) {
            // File path similarity
            const maxPathSimilarity = Math.max(
                ...error.impactedFiles.map(file => 
                    this.calculatePathSimilarity(pattern.context.file, file)
                )
            );
            score += maxPathSimilarity * 3;
            weights += 3;

            // Code similarity
            const errorSnippet = await this.getErrorCodeSnippet(error);
            if (errorSnippet) {
                const codeSimilarity = await this.calculateCodeSimilarity(
                    pattern.context.codeSnippet,
                    errorSnippet
                );
                score += codeSimilarity * 4;
                weights += 4;
            }

            // Symbol overlap
            const errorSymbols = await this.getErrorRelatedSymbols(error);
            const symbolOverlap = this.calculateSymbolOverlap(
                pattern.context.relatedSymbols,
                errorSymbols
            );
            score += symbolOverlap * 2;
            weights += 2;
        }

        return weights > 0 ? score / weights : 0;
    }

    private inferErrorType(errors: string[]): 'syntax' | 'semantic' | 'dependency' | 'memory' | 'impact' {
        const errorText = errors.join(' ').toLowerCase();
        
        if (errorText.includes('syntax') || errorText.includes('parse') || errorText.includes('token')) {
            return 'syntax';
        }
        if (errorText.includes('type') || errorText.includes('undefined') || errorText.includes('null')) {
            return 'semantic';
        }
        if (errorText.includes('import') || errorText.includes('require') || errorText.includes('module')) {
            return 'dependency';
        }
        if (errorText.includes('memory') || errorText.includes('heap') || errorText.includes('stack')) {
            return 'memory';
        }
        if (errorText.includes('impact') || errorText.includes('affect') || errorText.includes('change')) {
            return 'impact';
        }
        
        // Default to semantic if we can't determine the type
        return 'semantic';
    }

    private async generateFixesFromPatterns(patterns: Pattern[], error: ValidationResult): Promise<ErrorCorrection[]> {
        const corrections: ErrorCorrection[] = [];
        const errorContext = {
            file: error.impactedFiles?.[0],
            code: await this.getErrorCodeSnippet(error),
            relatedSymbols: await this.getErrorRelatedSymbols(error)
        };

        for (const pattern of patterns) {
            // Get successful strategies sorted by success rate
            const successfulStrategies = pattern.strategies.successful
                .sort((a, b) => b.successRate - a.successRate)
                .slice(0, 3); // Take top 3 strategies

            for (const strategy of successfulStrategies) {
                const adaptedFixes = await this.adaptFixesToContext(
                    strategy.fixes,
                    pattern.context,
                    errorContext
                );

                if (adaptedFixes) {
                    corrections.push({
                        errorType: pattern.errorType,
                        severity: this.inferErrorSeverity(error.errors || []),
                        context: errorContext,
                        suggestedFixes: [{
                            description: `Based on successful pattern ${pattern.id}`,
                            changes: adaptedFixes,
                            confidence: strategy.successRate
                        }]
                    });
                }
            }
        }

        return corrections;
    }

    private inferErrorSeverity(errors: string[]): 'low' | 'medium' | 'high' | 'critical' {
        const errorText = errors.join(' ').toLowerCase();
        
        if (errorText.includes('critical') || 
            errorText.includes('fatal') || 
            errorText.includes('crash') ||
            errorText.includes('security')) {
            return 'critical';
        }
        
        if (errorText.includes('error') || 
            errorText.includes('fail') || 
            errorText.includes('invalid')) {
            return 'high';
        }
        
        if (errorText.includes('warning') || 
            errorText.includes('deprecated')) {
            return 'medium';
        }
        
        return 'low';
    }

    private async adaptFixesToContext(
        fixes: ModelFileOperation[],
        originalContext: Pattern['context'],
        newContext: any
    ): Promise<ModelFileOperation[] | null> {
        try {
            return fixes.map(fix => ({
                ...fix,
                filePath: this.adaptPath(fix.filePath, originalContext.file, newContext.file),
                content: this.adaptContent(fix.content, originalContext, newContext)
            }));
        } catch (error) {
            this.outputChannel.appendLine(`Error adapting fixes: ${error}`);
            return null;
        }
    }

    private contextToString(context: any): string {
        return `${context.file}:${context.line || ''}`;
    }

    private areFixesSimilar(fixes1: ModelFileOperation[], fixes2: ModelFileOperation[]): boolean {
        // Implement similarity check based on operation types and affected areas
        return true; // Placeholder
    }

    private calculatePathSimilarity(path1: string, path2: string): number {
        // Implement path similarity calculation
        return 0.5; // Placeholder
    }

    private async calculateCodeSimilarity(snippet1: string, snippet2: string): Promise<number> {
        // Implement code similarity calculation
        return 0.5; // Placeholder
    }

    private calculateSymbolOverlap(symbols1: string[], symbols2: string[]): number {
        // Implement symbol overlap calculation
        return 0.5; // Placeholder
    }

    private async getErrorCodeSnippet(error: ValidationResult): Promise<string> {
        // Implement error code snippet extraction
        return ''; // Placeholder
    }

    private async getErrorRelatedSymbols(error: ValidationResult): Promise<string[]> {
        // Implement error related symbols extraction
        return []; // Placeholder
    }

    private adaptPath(path: string | undefined, originalPath: string, newPath: string): string | undefined {
        if (!path) return undefined;
        // Implement path adaptation logic
        return path;
    }

    private adaptContent(content: string | undefined, originalContext: any, newContext: any): string | undefined {
        if (!content) return undefined;
        // Implement content adaptation logic
        return content;
    }

    private extractRelevantCodeSnippet(fileContent: string, line: number): string {
        // Implement code snippet extraction
        return ''; // Placeholder
    }

    private initializePattern(pattern: Pattern, correction: ErrorCorrection, success: boolean): Pattern {
        const newPattern = { ...pattern };
        this.updateExistingPattern(newPattern, correction, success);
        return newPattern;
    }
}
