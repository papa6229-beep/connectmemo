<p align="center">
  <img src="assets/icon.png" width="120" alt="Connect AI Logo" />
</p>

<h1 align="center">Connect AI</h1>

<p align="center">
  <strong>100% Local · 100% Offline · 100% Free</strong><br/>
  Your AI coding agent that lives entirely on your machine.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-2.1.2-blue" alt="version" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license" />
  <img src="https://img.shields.io/badge/platform-VS%20Code%20%7C%20Cursor%20%7C%20Antigravity-purple" alt="platform" />
  <img src="https://img.shields.io/badge/engine-Ollama%20%7C%20LM%20Studio-orange" alt="engine" />
</p>

---

## Overview

Connect AI is an **agentic AI coding assistant** that runs entirely on your local machine — no cloud, no API keys, no data leaves your computer. It reads your project, creates files, edits code, manages directories, and executes terminal commands — all through natural conversation.

Built for **VS Code**, **Cursor**, and **Antigravity**.

---

## ⚡ Agent Capabilities

Connect AI doesn't just answer questions — it **acts**. Seven built-in agent actions give it full control over your development environment:

| Action | Description |
|:--|:--|
| **📄 Create Files** | Generates new files and directories in your workspace |
| **✏️ Edit Files** | Finds and replaces specific code in existing files |
| **🗑️ Delete Files** | Removes files and folders |
| **📖 Read Files** | Reads any file in your workspace to understand context |
| **📂 Browse Directories** | Lists contents of any subdirectory |
| **🖥️ Run Terminal Commands** | Executes CLI commands (install, build, run, deploy) |
| **🧠 Second Brain** | Queries your personal knowledge base (GitHub-synced) |

### How It Works

```
You: "React로 카운터 앱 만들어줘"

Connect AI:
  ✅ 생성: src/App.jsx
  ✅ 생성: src/index.js
  ✅ 생성: index.html
  🖥️ 실행: npm install react react-dom
```

All files are created **directly in your local workspace** — no copy-paste needed.

---

## 🎨 Interface Features

- **🔄 Real-time Streaming** — Token-by-token response rendering
- **⬛ Abort (Stop)** — Interrupt generation mid-stream
- **🔄 재생성** — Regenerate any response with one click
- **📎 Multimodal Input** — Paste images (Cmd+V) or attach files (+)
- **💡 Syntax Highlighting** — Cinematic code block rendering
- **⏱️ Thinking Bar** — Visual latency indicator during inference

---

## 📥 Installation

### Option 1: VSIX (Recommended)

1. Download the latest `.vsix` from [Releases](https://github.com/wonseokjung/connect-ai/releases)
2. Open VS Code / Cursor / Antigravity
3. `Cmd+Shift+P` → **Extensions: Install from VSIX** → Select the file

### Option 2: Build from Source

```bash
git clone https://github.com/wonseokjung/connect-ai.git
cd connect-ai
npm install
npm run compile
npx vsce package
```

---

## ⚙️ Engine Setup

Connect AI requires a local AI engine. Choose one:

### Ollama (Recommended for Beginners)

```bash
# 1. Install
brew install ollama

# 2. Pull a model
ollama pull gemma3

# 3. Done — Ollama runs automatically in the background
```

### LM Studio (Recommended for Apple Silicon)

1. Download from [lmstudio.ai](https://lmstudio.ai/)
2. Search and download a model (e.g., Gemma 4, Llama 3.1)
3. Go to **Developer tab** (`<>` icon) → **Start Server**
4. Ensure it shows `http://127.0.0.1:1234`
5. In Connect AI: **⚙️ Settings** → Select **LM Studio**

> **💡 Tip:** In LM Studio, set **Context Length** to 8192+ for best results.

### Supported Models

| Model | Size | Best For |
|:--|:--|:--|
| Gemma 4 E2B | 4.4 GB | Vision + Code (Recommended) |
| Gemma 3 | 3-5 GB | Fast general coding |
| Llama 3.1 | 4-8 GB | Multi-language support |
| Qwen 3 | 4-8 GB | Strong instruction following |
| DeepSeek Coder | 6-16 GB | Code-heavy tasks |

---

## 🧠 Second Brain (Knowledge Base)

Sync a GitHub repository as your personal knowledge base. Connect AI will reference it when answering questions.

1. Click **🧠** button in the chat header
2. Enter your GitHub repo URL
3. Toggle knowledge mode **ON**

Your documents are stored locally at `~/.connect-ai-brain/`.

---

## 🔒 Privacy

- **Zero cloud dependency** — No internet required after setup
- **Zero data collection** — All code stays on your machine
- **Zero telemetry** — No analytics, no tracking

Your code never leaves your computer. Period.

---

## 🛠️ Configuration

Access settings via the **⚙️** button in the chat panel:

| Setting | Default | Description |
|:--|:--|:--|
| Engine | Ollama | Ollama or LM Studio |
| Temperature | 0.7 | Response creativity (0.0–1.0) |
| Top P | 0.9 | Nucleus sampling |
| Top K | 40 | Token selection range |

---

## License

MIT — Free to use, modify, and distribute.

---

<p align="center">
  <strong>Designed & Developed by <a href="https://github.com/wonseokjung">EZERAI</a> × Connect AI</strong>
</p>
