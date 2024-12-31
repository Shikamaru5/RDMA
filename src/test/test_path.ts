import { spawn, spawnSync } from 'child_process';
import { IncomingMessage } from 'http';

// Type definitions
type HttpMethod = 'GET' | 'POST';
type OllamaEndpoint = 'version' | 'generate' | 'tags';

interface OllamaResponse {
    response?: string;
    version?: string;
    models?: Array<{ name: string }>;
}

// Windows executables - use the Windows-style paths directly
const POWERSHELL = 'powershell.exe';
const ollamaWindowsPath = 'C:\\Users\\Kalvin\\AppData\\Local\\Programs\\Ollama\\ollama.exe';

// Function to make HTTP requests to Ollama
async function ollamaRequest(
    path: OllamaEndpoint, 
    method: HttpMethod = 'GET', 
    body: Record<string, any> | null = null
): Promise<string> {
    const http = require('http');
    
    // Try both IPv6 and IPv4
    const hosts = [
        { hostname: '172.27.208.1', family: 4 }, // Windows host IP from WSL
        { hostname: '127.0.0.1', family: 4 },    // IPv4 localhost
        { hostname: '::1', family: 6 },          // IPv6 localhost
        { hostname: '0.0.0.0', family: 4 }       // IPv4 any
    ];

    let lastError: Error | null = null;

    for (const host of hosts) {
        try {
            const result = await new Promise<string>((resolve, reject) => {
                const options = {
                    hostname: host.hostname,
                    port: 11434,
                    path: `/api/${path}`,
                    method: method,
                    headers: body ? { 'Content-Type': 'application/json' } : {},
                    family: host.family
                };

                console.log(`Trying to connect to ${host.hostname}:11434 (IPv${host.family})...`);

                const req = http.request(options, (res: IncomingMessage) => {
                    let data = '';
                    res.on('data', (chunk: Buffer) => {
                        data += chunk;
                        // For streaming responses, try to parse each chunk
                        if (path === 'generate') {
                            try {
                                const jsonChunk = JSON.parse(chunk.toString()) as OllamaResponse;
                                if (jsonChunk.response) {
                                    console.log(jsonChunk.response);
                                }
                            } catch (e) {
                                // Ignore parsing errors for partial chunks
                            }
                        }
                    });

                    res.on('end', () => {
                        if (path !== 'generate') {
                            console.log(`${path} response:`, data);
                        }
                        resolve(data);
                    });
                });

                req.on('error', (err: Error) => {
                    console.error(`Error with ${path} on ${host.hostname}:`, err.message);
                    reject(err);
                });

                if (body) {
                    req.write(JSON.stringify(body));
                }
                req.end();
            });

            // If we get here, the connection worked
            return result;
        } catch (error) {
            lastError = error as Error;
            // Continue to next host
        }
    }

    // If we get here, none of the hosts worked
    throw lastError;
}

console.log('Initializing Ollama test from WSL...');

// First, check if the process is running in Windows using PowerShell
console.log('Checking if Ollama is running in Windows...');
const checkProcess = spawnSync(POWERSHELL, ['-Command', 'Get-Process ollama -ErrorAction SilentlyContinue'], { encoding: 'utf8' });

if (checkProcess.stdout && checkProcess.stdout.trim()) {
    console.log('Ollama process found in Windows, attempting to stop it...');
    const killProcess = spawnSync(POWERSHELL, ['-Command', 'Stop-Process -Name ollama -Force']);
    console.log('Kill process result:', killProcess.stderr ? killProcess.stderr : 'Process stopped successfully');
}

// Wait a moment for the process to fully terminate
console.log('Waiting for process to terminate...');
setTimeout(() => {
    // Check if Ollama exists using PowerShell
    console.log('Checking if Ollama executable exists...');
    try {
        const checkFile = spawnSync(POWERSHELL, [
            '-Command',
            `Test-Path '${ollamaWindowsPath}'`
        ], { encoding: 'utf8' });
        
        // Debug output
        console.log('Check file command result:', {
            stdout: checkFile.stdout,
            stderr: checkFile.stderr,
            error: checkFile.error,
            status: checkFile.status
        });

        const exists = checkFile.stdout && checkFile.stdout.trim().toLowerCase() === 'true';
        console.log('Ollama executable exists:', exists);

        if (exists) {
            // Start the Ollama server from WSL using PowerShell
            console.log('Starting Ollama server from WSL...');
            
            // Create a script block that will keep running
            const startCommand = spawn(POWERSHELL, [
                '-Command',
                `
                $env:OLLAMA_HOST = '0.0.0.0:11434'
                $env:OLLAMA_ORIGINS = '*'
                cd 'C:\\Users\\Kalvin\\AppData\\Local\\Programs\\Ollama'
                
                # Start Ollama and capture its output
                $process = Start-Process -FilePath .\\ollama.exe -ArgumentList 'serve' -PassThru -NoNewWindow -RedirectStandardOutput ollama.log -RedirectStandardError ollama.error.log

                # Output process info for debugging
                Write-Host "Started Ollama process with ID: $($process.Id)"
                
                # Wait for the process
                Wait-Process -Id $process.Id
                `
            ], {
                stdio: ['inherit', 'pipe', 'pipe']
            });

            // Capture output for debugging
            startCommand.stdout.on('data', (data: Buffer) => {
                console.log('PowerShell output:', data.toString());
            });

            startCommand.stderr.on('data', (data: Buffer) => {
                console.error('PowerShell error:', data.toString());
            });

            startCommand.on('error', (err: Error) => {
                console.error('Failed to start Ollama:', err);
            });

            startCommand.on('close', (code: number | null) => {
                console.log(`PowerShell process exited with code ${code}`);
            });

            // Check server status and test the model
            setTimeout(async () => {
                try {
                    // Check log files first
                    console.log('Checking Ollama logs...');
                    const checkLogs = spawnSync(POWERSHELL, [
                        '-Command',
                        `
                        $logPath = 'C:\\Users\\Kalvin\\AppData\\Local\\Programs\\Ollama\\ollama.log'
                        $errorLogPath = 'C:\\Users\\Kalvin\\AppData\\Local\\Programs\\Ollama\\ollama.error.log'
                        
                        if (Test-Path $logPath) {
                            Write-Host "=== Ollama Log ==="
                            Get-Content $logPath
                        } else {
                            Write-Host "No ollama.log file found"
                        }
                        
                        if (Test-Path $errorLogPath) {
                            Write-Host "=== Ollama Error Log ==="
                            Get-Content $errorLogPath
                        } else {
                            Write-Host "No ollama.error.log file found"
                        }
                        `
                    ], { encoding: 'utf8' });
                    
                    if (checkLogs.stdout) console.log(checkLogs.stdout);
                    if (checkLogs.stderr) console.error(checkLogs.stderr);

                    // Check if server is running
                    const versionData = await ollamaRequest('version');
                    console.log('Server is running, testing hermes3:8b model...');

                    // Test the model with a simple prompt
                    console.log('Running test with hermes3:8b model...');
                    await ollamaRequest('generate', 'POST', {
                        model: 'hermes3:8b',
                        prompt: 'What is the capital of France? Please answer in one sentence.',
                        stream: true
                    });

                } catch (error) {
                    console.error('Error during model operations:', error);
                }
            }, 5000);

        } else {
            console.error('Ollama executable not found at:', ollamaWindowsPath);
        }
    } catch (error) {
        console.error('Error:', error);
    }
}, 2000);
