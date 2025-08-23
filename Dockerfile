FROM python:3.11-slim

# Set environment variables to avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive
ENV TERM=xterm-256color

# Update and install system dependencies based on tinstar requirements
RUN apt-get update && apt-get install -y \
    # Core system tools
    curl \
    wget \
    git \
    vim \
    # tinstar dependencies from installer.py
    jq \
    tmux \
    # Node.js and npm
    nodejs \
    npm \
    # Additional utilities
    build-essential \
    sudo \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Create a user for running the application
RUN useradd -m -s /bin/bash testuser && \
    echo "testuser ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Install Claude Code CLI as root first, then make it available to testuser
RUN curl -fsSL https://claude.ai/cli/install.sh | bash || \
    (echo "Claude installer failed, will install manually" && \
     npm install -g claude-code@latest 2>/dev/null || \
     echo "Claude installation deferred - will need to be done at runtime")

# Switch to the test user
USER testuser
WORKDIR /home/testuser

# Create necessary directories
RUN mkdir -p /home/testuser/.claude \
    /home/testuser/.tinstar/{db,logs,worktrees,sessions} \
    /home/testuser/tinstar

# Copy the project files
COPY --chown=testuser:testuser . /home/testuser/tinstar/

# Install tinstar and dependencies
WORKDIR /home/testuser/tinstar
RUN pip install --upgrade pip && \
    pip install -r requirements.txt && \
    pip install requests websockets && \
    pip install -e .

# Claude credentials will be mounted at runtime

# Set up tinstar configuration and install hooks
RUN tinstar install || echo "Install may fail without Claude credentials, will retry at runtime"

# Create a startup script
RUN echo '#!/bin/bash\n\
set -e\n\
\n\
# Add local bin to PATH\n\
export PATH="/home/testuser/.local/bin:$PATH"\n\
\n\
echo "🚀 Starting tinstar container..."\n\
echo "📁 Working directory: $(pwd)"\n\
echo "🐍 Python version: $(python --version)"\n\
echo "📦 Node version: $(node --version)"\n\
\n\
# Check if Claude is available, install if needed\n\
if ! command -v claude &> /dev/null; then\n\
    echo "🎭 Installing Claude Code CLI..."\n\
    curl -fsSL https://claude.ai/cli/install.sh | bash || \n\
        echo "⚠️  Claude installation failed. Please install manually."\n\
else\n\
    echo "🎭 Claude version: $(claude --version)"\n\
fi\n\
\n\
echo "⭐ tmux version: $(tmux -V)"\n\
\n\
# Using system Python (no venv needed)\n\
\n\
# Install tinstar hooks if not already done\n\
echo "🔧 Installing tinstar hooks..."\n\
tinstar install || echo "⚠️  Hook installation may require Claude credentials"\n\
\n\
# Show tinstar version\n\
echo "🌟 Tinstar version: $(tinstar --help | head -1)"\n\
\n\
# List available commands\n\
echo ""\n\
echo "Available commands:"\n\
echo "  tinstar --help          # Show help"\n\
echo "  tinstar project list    # List projects"\n\
echo "  tinstar session list    # List sessions"\n\
echo ""\n\
echo "🎯 Ready! You can now use tinstar commands."\n\
\n\
# Execute any command passed to the container\n\
if [ $# -gt 0 ]; then\n\
    exec "$@"\n\
else\n\
    exec /bin/bash\n\
fi' > /home/testuser/entrypoint.sh && \
    chmod +x /home/testuser/entrypoint.sh

# Set the entrypoint
ENTRYPOINT ["/home/testuser/entrypoint.sh"]

# Default command
CMD ["/bin/bash"]

# Expose any ports that might be needed (tinstar server)
EXPOSE 8000