# RDMA
A local Windsurf-type program using Ollama.

An intelligent coding assistant powered by Ollama models, providing capabilities similar to Windsurf. I wanted to be able to have it think through it's actions, and really make sure that it was doing what I asked it to, thus I used Hermes3 to have it follow prompts fairly strictly, and create action plans to execute. Having Qwen2.5-coder brought in to do complex coding tasks. It makes sure to handle memory better as Windsurf struggles with this, and there was special emphasis put on proper file analysis. After everytime it edits or creates files it analyzes the codes for errors and for prompt adherence, and if it isn't following the prompt to either try again or change the plan from that point on to do so. This is still in semi active development but I still think it's pretty cool and can do some interesting stuff thus far. It's relatively fast, takes about a minute or so to generate anything easy after it's loaded. I've just been testing it in my dev env. Probably would be faster on better hardware, currently only packing a Nvidia geforce 1660 gpu so anything better would probably make this a really useful program. Could probably do with multi-gpu support. Also it could probably be changed from having these models to others and or even using apis like claude or chatgpt.

## Features

- Multiple model support (qwen2.5-coder, hermes3, llama3.2-vision)
- File analysis and management
- Code editing
- File and folder creation and deletion
- Image analysis - not yet
- Terminal command management - sorta
- Real-time chat interface
- Intelligent code analysis
- multi-step planning
- plan adaptation
- sophisticated error handling
- Windsurf style acceptance/rejection of code changes - untested

## Setup

1. clone vscode:
Make sure to clone vscode, I only did a shallow clone of it because I don't have a lot of space in memory for such a download and don't need the fully thing but whatever you feel like doing.

3. Install dependencies:
```bash
pip install -r requirements.txt
```

3. Install Node.js dependencies:
```bash
cd frontend
npm install
```

4. Configure Ollama:
Make sure Ollama is installed and the models are available:
- qwen2.5-coder:7b
- hermes3:8b
- llama3.2-vision (optional)

## Development/things that need to be done.

Ui:
I haven't really done much work on the user interface because I was making it work before anything else.

Vision model:
Haven't really integrated the vision model yet, was hoping to have it be able to analyze images and that way it could help in coding like Windsurf does.

Multi-step execution of analysis/general chat type requests:
It won't go beyond the first planning step if it's a basic analysis or chat to start the plan. Will do that for code creation and editing though of files and folders.

Terminal command execution:
I believe I still need to do a bunch of work on getting it to do this

Start the backend:
```bash
python backend/main.py
```

Start the frontend:
```bash
cd frontend
npm run dev
```
