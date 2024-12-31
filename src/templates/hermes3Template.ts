import { TaskType, TaskContext } from '../types';

export const HERMES3_SYSTEM_TEMPLATE = `You are Hermes3, an advanced AI assistant. You can handle both general questions and specialized tasks like code generation and analysis.

When you need to perform file operations, wrap your response in <tool_call> tags and use this JSON format:

<tool_call>
{
    "operations": [
        {
            "type": "create",
            "filePath": "[path relative to workspace]",
            "content": "[file contents]",
            "language": "[programming language]",
            "completionLevel": "basic" | "standard" | "complete"
        },
        {
            "type": "createDirectory",
            "targetDirectory": "[path relative to workspace]"
        },
        {
            "type": "edit",
            "filePath": "[path to file]",
            "edits": [
                {
                    "startLine": 0,
                    "endLine": 0,
                    "newContent": "[new content]"
                }
            ]
        }
    ],
    "explanation": "[user-friendly message about what was done]"
}
</tool_call>

For regular chat responses that don't involve file operations, just respond with the text directly.`;

export const generateTaskPrompt = (input: { 
    prompt: string, 
    previousMessages?: any[], 
    systemPrompt?: string,
    taskContext?: TaskContext 
}) => {
    console.log('Generating task prompt with input:', JSON.stringify(input, null, 2));
    
    const messages: Array<{role: string, content: string}> = [];
    const taskContext = input.taskContext;

    // Add minimal system prompt based on task type
    if (taskContext) {
        switch (taskContext.type) {
            case 'code':
                messages.push({
                    role: 'system',
                    content: 'You are a code specialist. Focus on code analysis, generation, and debugging. Provide clear, efficient solutions.'
                });
                break;
            case 'image':
                messages.push({
                    role: 'system',
                    content: 'You are an image analysis specialist. Focus on understanding and describing visual content.'
                });
                break;
            default:
                messages.push({
                    role: 'system',
                    content: input.systemPrompt || HERMES3_SYSTEM_TEMPLATE
                });
        }
    } else {
        messages.push({
            role: 'system',
            content: input.systemPrompt || HERMES3_SYSTEM_TEMPLATE
        });
    }

    // Add previous messages if they exist, but limit to last 5 relevant messages
    if (input.previousMessages && input.previousMessages.length > 0) {
        const relevantMessages = input.previousMessages.slice(-5);
        messages.push(...relevantMessages.map(msg => ({
            role: msg.role,
            content: msg.content
        })));
    }

    // Generate task-specific prompt
    let taskPrompt = '';
    if (taskContext) {
        switch (taskContext.type) {
            case 'code':
                taskPrompt = generateCodeSpecialistPrompt(input.prompt, taskContext);
                break;
            case 'image':
                taskPrompt = generateVisionSpecialistPrompt(input.prompt, taskContext);
                break;
            default:
                taskPrompt = input.prompt;
        }
    } else {
        taskPrompt = input.prompt;
    }

    // Add current user message
    messages.push({
        role: 'user',
        content: taskPrompt
    });

    return messages;
};

function generateCodeSpecialistPrompt(prompt: string, context: TaskContext): string {
    // Keep code prompts focused and specific
    return `Code Task:
Target: ${context.targetModel || 'Not specified'}
${prompt}`;
}

function generateVisionSpecialistPrompt(prompt: string, context: TaskContext): string {
    // Keep image prompts focused on visual analysis
    return `Image Analysis Task:
${prompt}`;
}

export const validateResponse = (response: any): boolean => {
    // Check if response is a tool call
    if (typeof response === 'string') {
        return true; // Plain text responses are always valid
    }

    try {
        // Validate operations array
        if (!Array.isArray(response.operations)) {
            return false;
        }

        // Validate each operation
        for (const op of response.operations) {
            if (!op.type) return false;
            
            switch (op.type) {
                case 'create':
                    if (!op.filePath || !op.content || !op.language) return false;
                    break;
                case 'createDirectory':
                    if (!op.targetDirectory) return false;
                    break;
                case 'edit':
                    if (!op.filePath || !Array.isArray(op.edits)) return false;
                    for (const edit of op.edits) {
                        if (typeof edit.startLine !== 'number' || 
                            typeof edit.endLine !== 'number' || 
                            !edit.newContent) return false;
                    }
                    break;
                default:
                    return false;
            }
        }

        return true;
    } catch (error) {
        return false;
    }
};