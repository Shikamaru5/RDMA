import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import { ModelCoordinator } from '../../services/modelCoordinator';
import { OllamaService } from '../../services/ollamaService';
import { EventEmitter } from 'events';

function createMockEvent<T>(): vscode.Event<T> {
    const emitter = new EventEmitter();
    const event = (listener: (e: T) => any, disposables?: vscode.Disposable[]): vscode.Disposable => {
        const disposable = {
            dispose: () => {
                emitter.removeListener('event', listener);
            }
        };

        if (disposables) {
            disposables.push(disposable);
        }

        emitter.on('event', listener);

        return disposable;
    };

    // Add the fire method for testing
    (event as any).fire = (data: T) => {
        emitter.emit('event', data);
    };

    return event;
}

suite('ModelCoordinator Test Suite', () => {
    let mockContext: vscode.ExtensionContext;
    let modelCoordinator: ModelCoordinator;
    let ollamaService: OllamaService;
    let mockOutputChannel: vscode.OutputChannel;

    suiteSetup(async function() {
        // This hook runs once before all tests
        this.timeout(120000); // Allow 2 minutes for initial setup including model loading
        
        // Create output channel that actually logs
        mockOutputChannel = {
            append: (msg: string) => console.log(msg),
            appendLine: (msg: string) => console.log(msg),
            clear: () => {},
            dispose: () => {},
            hide: () => {},
            show: () => {},
            replace: (value: string) => {},
            name: 'Test Channel'
        };

        // Create context with minimal mocking
        mockContext = {
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
            extensionPath: __dirname,
            storagePath: path.join(__dirname, '.storage'),
            globalStoragePath: path.join(__dirname, '.global-storage'),
            logPath: path.join(__dirname, '.log'),
            extensionUri: vscode.Uri.file(__dirname),
            environmentVariableCollection: {
                persistent: true,
                replace: () => {},
                append: () => {},
                prepend: () => {},
                get: () => undefined,
                forEach: () => {},
                delete: () => {},
                clear: () => {},
                [Symbol.iterator]: function* () { yield* []; }
            },
            extensionMode: vscode.ExtensionMode.Development,
            storageUri: vscode.Uri.file(path.join(__dirname, '.storage')),
            globalStorageUri: vscode.Uri.file(path.join(__dirname, '.global-storage')),
            logUri: vscode.Uri.file(path.join(__dirname, '.log')),
            asAbsolutePath: (p: string) => path.join(__dirname, p),
            extension: {
                id: 'test.extension',
                extensionUri: vscode.Uri.file(__dirname),
                extensionPath: __dirname,
                isActive: true,
                packageJSON: {},
                extensionKind: vscode.ExtensionKind.Workspace,
                exports: undefined
            },
            createOutputChannel: () => mockOutputChannel
        } as unknown as vscode.ExtensionContext;

        // Initialize services
        ollamaService = new OllamaService(mockContext);
        
        try {
            // Wait for service initialization
            await ollamaService.waitForInitialization();
            
            // Initialize ModelCoordinator
            modelCoordinator = new ModelCoordinator(ollamaService, mockContext);
            
            // Explicitly switch to initial model like the chat panel does
            const modelSwitched = await ollamaService.switchModel('hermes3:8b');
            if (!modelSwitched) {
                throw new Error('Failed to switch to initial model');
            }
            
            console.log('Test environment successfully initialized');
            
        } catch (error) {
            console.error('Test setup failed:', error);
            throw error;
        }
    });

    test('General chat capability', async function() {
        this.timeout(30000); // Allow 30 seconds for chat response
        const result = await modelCoordinator.handleTask(
            'Explain what a fibonacci sequence is in simple terms'
        );
        assert.ok(result, 'Should return a response');
    });

    test('Code generation capability', async function() {
        this.timeout(30000); // Allow 30 seconds for code generation
        const result = await modelCoordinator.handleTask(
            'Write a TypeScript function that implements binary search'
        );
        assert.ok(result, 'Should return generated code');
    });

    test('Code analysis capability', async function() {
        this.timeout(30000); // Allow 30 seconds for code analysis
        const result = await modelCoordinator.handleTask(
            'Analyze this code and suggest improvements:\n' +
            'function add(a,b) { return a + b; }'
        );
        assert.ok(result, 'Should return code analysis');
    });

    test('Model switching', async function() {
        this.timeout(30000); // Allow 30 seconds for model switching
        const result = await modelCoordinator.handleTask(
            'Switch to model:codellama'
        );
        assert.ok(result, 'Should return confirmation of model switch');
    });
});
