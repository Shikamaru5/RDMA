import * as vscode from 'vscode';
import { ModelCoordinator } from './services/modelCoordinator';
import { OllamaService } from './services/ollamaService';
import { EventEmitter } from 'events';

function createMockEvent<T>(): vscode.Event<T> {
    const emitter = new EventEmitter();
    const event = (listener: (e: T) => any, thisArgs?: any, disposables?: vscode.Disposable[]): vscode.Disposable => {
        const bound = thisArgs ? listener.bind(thisArgs) : listener;
        emitter.on('event', bound);

        const disposable = {
            dispose: () => {
                emitter.removeListener('event', bound);
            }
        };

        if (disposables) {
            disposables.push(disposable);
        }

        return disposable;
    };

    // Add the fire method for testing
    (event as any).fire = (data: T) => {
        emitter.emit('event', data);
    };

    return event;
}

// Mock vscode.ExtensionContext
const mockContext = {
    subscriptions: [],
    workspaceState: {
        get: () => undefined,
        update: () => Promise.resolve(),
        keys: () => []
    },
    globalState: {
        get: () => undefined,
        update: () => Promise.resolve(),
        keys: () => [],
        setKeysForSync: () => {}
    },
    extensionPath: '/mock/extension/path',
    storagePath: '/mock/storage/path',
    globalStoragePath: '/mock/global/storage/path',
    logPath: '/mock/log/path',
    extensionUri: vscode.Uri.file('/mock/extension/path'),
    globalStorageUri: vscode.Uri.file('/mock/global/storage/path'),
    logUri: vscode.Uri.file('/mock/log/path'),
    asAbsolutePath: (relativePath: string) => `/mock/extension/path/${relativePath}`,
    environmentVariableCollection: {
        persistent: true,
        description: 'Mock Environment Variables',
        replace: () => {},
        append: () => {},
        prepend: () => {},
        get: () => undefined,
        forEach: () => {},
        delete: () => {},
        clear: () => {},
        getScoped: () => ({} as any),
        [Symbol.iterator]: function* () { yield* []; }
    },
    extensionMode: vscode.ExtensionMode.Development,
    storageUri: vscode.Uri.file('/mock/storage/path'),
    secrets: {
        get: () => Promise.resolve(undefined),
        store: () => Promise.resolve(),
        delete: () => Promise.resolve(),
        onDidChange: createMockEvent<vscode.SecretStorageChangeEvent>()
    },
    extension: {
        id: 'mock.extension',
        extensionUri: vscode.Uri.file('/mock/extension/path'),
        extensionPath: '/mock/extension/path',
        isActive: true,
        packageJSON: {},
        exports: undefined,
        activate: () => Promise.resolve(),
        extensionKind: vscode.ExtensionKind.Workspace
    },
    languageModelAccessInformation: {
        endpoint: 'http://localhost:11434',
        authHeader: 'Bearer mock-token',
        onDidChange: createMockEvent<void>(),
        canSendRequest: true
    }
} as unknown as vscode.ExtensionContext;

// Mock vscode.window
const mockWindow = {
    createOutputChannel: (name: string) => ({
        append: () => {},
        appendLine: () => {},
        clear: () => {},
        dispose: () => {},
        hide: () => {},
        show: () => {},
        name
    })
};

// Replace vscode.window with our mock
(vscode as any).window = mockWindow;

async function testModelCoordinator() {
    // Initialize services
    const ollamaService = new OllamaService(mockContext);
    const modelCoordinator = new ModelCoordinator(ollamaService, mockContext);

    try {
        console.log('Starting ModelCoordinator capability tests...\n');

        // Test 1: General chat capability
        console.log('Test 1: Testing general chat capability...');
        const chatResult = await modelCoordinator.handleTask(
            'Explain what a fibonacci sequence is in simple terms'
        );
        console.log('Chat Result:', chatResult, '\n');

        // Test 2: Code generation capability
        console.log('Test 2: Testing code generation capability...');
        const codeResult = await modelCoordinator.handleTask(
            'Write a TypeScript function that implements binary search'
        );
        console.log('Code Generation Result:', codeResult, '\n');

        // Test 3: Code analysis capability
        console.log('Test 3: Testing code analysis capability...');
        const analysisResult = await modelCoordinator.handleTask(
            'Analyze this code and suggest improvements:\n' +
            'function add(a,b) { return a + b; }'
        );
        console.log('Code Analysis Result:', analysisResult, '\n');

        // Test 4: Model switching
        console.log('Test 4: Testing model switching...');
        const currentModel = modelCoordinator.getCurrentModel();
        console.log('Current Model:', currentModel);
        
        // Force a model switch by requesting code generation
        await modelCoordinator.handleTask('Write a function to calculate prime numbers');
        const newModel = modelCoordinator.getCurrentModel();
        console.log('Model after code task:', newModel, '\n');

        console.log('All tests completed successfully!');

    } catch (error) {
        console.error('Error during testing:', error);
    }
}

// Run the tests
testModelCoordinator().catch(console.error);
