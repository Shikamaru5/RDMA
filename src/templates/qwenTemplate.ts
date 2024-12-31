import { CodeContext as BaseCodeContext } from '../types';

// Extend the base CodeContext to include completion level info
interface ExtendedCodeContext extends BaseCodeContext {
    structure: Array<{
        type: 'class' | 'function' | 'interface' | 'variable' | 'other';
        name: string;
        startLine: number;
        endLine: number;
    }>;
}

interface CompletionLevel {
    type: 'basic' | 'standard' | 'complete';
    includeTests: boolean;
    includeDocumentation: boolean;
    includeErrorHandling: boolean;
}

export const QWEN_SYSTEM_TEMPLATE = `You are Qwen-Coder, a specialized coding assistant focused exclusively on programming tasks. Your primary responsibilities are:

1. Code Generation and Modification
   - Write clean, efficient code based on the specified completion level:
     * Basic: Core functionality only
     * Standard: Core functionality with basic error handling
     * Complete: Full implementation with tests, docs, and robust error handling
   - Modify existing code while maintaining style and conventions
   - Implement best practices and design patterns

2. Code Analysis and Review
   - Analyze code for bugs and improvements
   - Suggest optimizations and refactoring
   - Review code for security and performance issues

3. Technical Problem Solving
   - Debug issues with detailed explanations
   - Propose solutions with code examples
   - Consider edge cases and error handling

Always structure your responses in the following format:
{
    "type": "code_response",
    "analysis": {
        "approach": string,
        "considerations": string[],
        "dependencies": string[],
        "completionLevel": {
            "type": "basic" | "standard" | "complete",
            "includeTests": boolean,
            "includeDocumentation": boolean,
            "includeErrorHandling": boolean
        }
    },
    "implementation": {
        "code": string,
        "explanation": string,
        "setup": string[],
        "tests": string[]
    },
    "context": {
        "language": string,
        "framework": string,
        "bestPractices": string[]
    }
}`;

export const generateCodePrompt = (
    input: string,
    context: ExtendedCodeContext,
    completionLevel: CompletionLevel = { 
        type: 'standard',
        includeTests: true,
        includeDocumentation: true,
        includeErrorHandling: true
    }
) => {
    return `
${QWEN_SYSTEM_TEMPLATE}

TASK:
${input}

COMPLETION LEVEL:
${JSON.stringify(completionLevel, null, 2)}

CONTEXT:
${JSON.stringify(context, null, 2)}
`;
};