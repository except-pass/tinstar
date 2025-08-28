# Tinstar Development Commands

# Start both the backend server and frontend UI
start:
    #!/usr/bin/env bash
    echo "Starting Tinstar backend and frontend..."
    
    # Start backend server in background on standard port 3002
    echo "Starting backend server..."
    nohup tinstar server --port 3002 --debug > .backend.log 2>&1 &
    BACKEND_PID=$!
    echo $BACKEND_PID > .backend.pid
    
    # Wait for backend to start up
    echo "Waiting for backend to start..."
    sleep 3
    
    # Check if backend is running
    if ! kill -0 $BACKEND_PID 2>/dev/null; then
        echo "❌ Backend failed to start. Checking .backend.log for details."
        echo "--------- .backend.log ----------------------"
        cat .backend.log
        exit 1
    fi
    
    # Start frontend in background with nohup
    echo "Starting frontend UI..."
    cd ui
    nohup npm run master > ../.frontend.log 2>&1 &
    FRONTEND_PID=$!
    echo $FRONTEND_PID > ../.frontend.pid
    cd ..
    
    # Wait a bit for frontend to start
    sleep 2
    
    echo ""
    echo "✅ Servers started successfully!"
    echo "Backend PID: $BACKEND_PID"
    echo "Frontend PID: $FRONTEND_PID"
    echo ""
    echo "URLs:"
    echo "  Backend:  http://localhost:3002"
    echo "--------- .frontend.log ----------------------"
    cat .frontend.log
    echo ""
    echo "Logs:"
    echo "  Backend:  tail -f .backend.log"
    echo "  Frontend: tail -f .frontend.log"
    echo ""
    echo "Use 'just stop' to stop both servers"
    echo "Use 'just status' to check server status"

# Stop both servers
stop:
    #!/usr/bin/env bash
    echo "Stopping Tinstar servers..."
    
    # Stop backend server
    if [ -f .backend.pid ]; then
        BACKEND_PID=$(cat .backend.pid)
        if kill -0 $BACKEND_PID 2>/dev/null; then
            echo "Stopping backend server (PID: $BACKEND_PID)"
            kill $BACKEND_PID
        fi
        rm -f .backend.pid
    fi
    
    # Stop frontend server
    if [ -f .frontend.pid ]; then
        FRONTEND_PID=$(cat .frontend.pid)
        if kill -0 $FRONTEND_PID 2>/dev/null; then
            echo "Stopping frontend server (PID: $FRONTEND_PID)"
            kill $FRONTEND_PID
        fi
        rm -f .frontend.pid
    fi
    
    # Kill any remaining tinstar-specific processes
    pkill -f "vite.*master.html" 2>/dev/null || true
    pkill -f "tinstar server" 2>/dev/null || true
    pkill -f "npm run master" 2>/dev/null || true
    
    echo "Servers stopped"

# Show status of running servers
status:
    #!/usr/bin/env bash
    echo "Tinstar server status:"
    echo ""
    
    # Check backend
    if [ -f .backend.pid ]; then
        BACKEND_PID=$(cat .backend.pid)
        if kill -0 $BACKEND_PID 2>/dev/null; then
            echo "✅ Backend server running (PID: $BACKEND_PID)"
            echo "   URL: http://localhost:3002"
        else
            echo "❌ Backend server not running (stale PID file)"
            rm -f .backend.pid
        fi
    else
        echo "❌ Backend server not running"
    fi
    
    # Check frontend
    if [ -f .frontend.pid ]; then
        FRONTEND_PID=$(cat .frontend.pid)
        if kill -0 $FRONTEND_PID 2>/dev/null; then
            echo "✅ Frontend server running (PID: $FRONTEND_PID)"
            # Try to detect actual port
            PORT=$(lsof -ti:3000,3001,3002 2>/dev/null | head -1)
            if [ -n "$PORT" ]; then
                ACTUAL_PORT=$(lsof -Pan -p $FRONTEND_PID 2>/dev/null | grep LISTEN | awk '{print $9}' | cut -d: -f2 | head -1)
                if [ -n "$ACTUAL_PORT" ]; then
                    echo "   URL: http://localhost:$ACTUAL_PORT"
                else
                    echo "   URL: Check console for actual port"
                fi
            fi
        else
            echo "❌ Frontend server not running (stale PID file)"
            rm -f .frontend.pid
        fi
    else
        echo "❌ Frontend server not running"
    fi

# View logs from both servers
logs:
    #!/usr/bin/env bash
    if [ -f .backend.log ] && [ -f .frontend.log ]; then
        echo "📋 Showing recent logs (last 20 lines each):"
        echo ""
        echo "=== Backend Logs ==="
        tail -20 .backend.log
        echo ""
        echo "=== Frontend Logs ==="
        tail -20 .frontend.log
        echo ""
        echo "For live logs, run:"
        echo "  Backend:  tail -f .backend.log"
        echo "  Frontend: tail -f .frontend.log"
    else
        echo "No log files found. Start the servers with 'just start' first."
    fi

# Clean up any leftover files
clean:
    rm -f .backend.pid .frontend.pid .backend.log .frontend.log
    @echo "Cleaned up PID and log files"

# Development setup - install dependencies
setup:
    #!/usr/bin/env bash
    echo "Setting up Tinstar development environment..."
    
    # Install Python dependencies
    if [ ! -d "venv" ]; then
        echo "Creating Python virtual environment..."
        python3 -m venv venv
    fi
    
    echo "Installing Python dependencies..."
    source venv/bin/activate && pip install -e .
    
    # Install Node.js dependencies
    echo "Installing Node.js dependencies..."
    cd ui && npm install
    
    echo "Setup complete!"
    echo "Run 'just start' to start both servers"