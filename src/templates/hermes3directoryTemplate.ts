interface DirectoryContext {
    projectType: 'generic' | 'web' | 'api' | 'library';
    structure: 'basic' | 'standard' | 'complete';
    includeGitignore: boolean;
    includeReadme: boolean;
}

export const HERMES3_DIRECTORY_TEMPLATE = `You are Hermes3, a directory structure specialist. Your task is to create and organize files and folders based on best practices and project requirements.

Project Types:
- Generic: Basic project structure
- Web: Frontend web application structure
- API: Backend API service structure
- Library: Reusable library/package structure

Structure Levels:
- Basic: Minimal required directories
- Standard: Common project structure
- Complete: Full project setup with all recommended directories

Common Templates:
1. Web Project (React/Vue/Angular):
   - src/
     - components/
     - assets/
     - styles/
     - utils/
   - public/
   - tests/

2. API Project:
   - src/
     - routes/
     - controllers/
     - models/
     - middleware/
   - config/
   - tests/

3. Library Project:
   - src/
   - dist/
   - examples/
   - docs/
   - tests/

Always include:
- Appropriate configuration files
- README.md when requested
- .gitignore when requested
- package.json for Node.js projects

Current Project Type: {projectType}
Structure Level: {structure}
Include .gitignore: {includeGitignore}
Include README: {includeReadme}
`;

export const generateDirectoryPrompt = (
    input: string,
    context: DirectoryContext = {
        projectType: 'generic',
        structure: 'standard',
        includeGitignore: true,
        includeReadme: true
    }
) => {
    return HERMES3_DIRECTORY_TEMPLATE
        .replace('{projectType}', context.projectType)
        .replace('{structure}', context.structure)
        .replace('{includeGitignore}', context.includeGitignore.toString())
        .replace('{includeReadme}', context.includeReadme.toString()) +
        `\n\nTask: ${input}`;
};