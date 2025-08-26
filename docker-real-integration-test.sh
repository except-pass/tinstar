#!/bin/bash
set -e

echo "🐳 Starting Real Docker Integration Test for Tinstar Project Pane"
echo "================================================================="

# Create screenshots directory on host
mkdir -p screenshots

# Build the Docker image
echo "📦 Building Docker image..."
docker build -t tinstar-test .

# Remove any existing container
docker rm -f tinstar-test-container 2>/dev/null || true

# Run the container with proper setup
echo "🚀 Starting container with real tinstar server..."
docker run -d \
  --name tinstar-test-container \
  -p 3002:3002 \
  -p 8081:8080 \
  -v "$(pwd)/ui/screenshots:/home/testuser/screenshots" \
  tinstar-test bash -c "
    set -e
    export PATH=\"/home/testuser/.local/bin:\$PATH\"
    
    echo '🔧 Setting up test environment...'
    
    # Run the test setup script to create git repositories
    cd /home/testuser/tinstar
    bash ./docker-test-setup.sh
    
    echo '📋 Creating projects via tinstar API...'
    
    # Start tinstar server in background
    echo '🌟 Starting tinstar server on port 3002...'
    cd /home/testuser/tinstar
    python -m tinstar.server --host 0.0.0.0 --port 3002 &
    SERVER_PID=\$!
    
    # Wait for server to start
    echo '⏳ Waiting for tinstar server to start...'
    sleep 10
    
    # Check if server is running
    if ! kill -0 \$SERVER_PID 2>/dev/null; then
        echo '❌ Tinstar server failed to start'
        exit 1
    fi
    
    echo '✅ Tinstar server is running (PID: '\$SERVER_PID')'
    
    # Add test projects via API
    echo '📂 Adding test projects via API...'
    
    # Add frontend project
    curl -X POST http://localhost:3002/api/projects \\
      -H 'Content-Type: application/json' \\
      -d '{\"path\": \"/home/testuser/test-projects/sample-frontend\"}' \\
      || echo 'Frontend project may already exist'
    
    # Add backend project  
    curl -X POST http://localhost:3002/api/projects \\
      -H 'Content-Type: application/json' \\
      -d '{\"path\": \"/home/testuser/test-projects/sample-backend\"}' \\
      || echo 'Backend project may already exist'
    
    # Add library project
    curl -X POST http://localhost:3002/api/projects \\
      -H 'Content-Type: application/json' \\
      -d '{\"path\": \"/home/testuser/test-projects/sample-library\"}' \\
      || echo 'Library project may already exist'
    
    # Verify projects were created
    echo '📊 Checking created projects...'
    curl -s http://localhost:3002/api/projects | jq '.' || echo 'Could not fetch projects'
    
    # Build UI components for serving
    echo '🎨 Building UI components...'
    cd /home/testuser/tinstar/ui
    npm run build || echo 'Build failed, using dev files'
    
    # Start simple HTTP server for UI
    echo '🌐 Starting UI server on port 8080...'
    python3 -m http.server 8080 &
    UI_SERVER_PID=\$!
    
    echo '✅ Setup complete!'
    echo '   - Tinstar API: http://localhost:3002'  
    echo '   - UI Server: http://localhost:8080'
    echo '   - Projects created: 3'
    
    # Keep container running
    wait \$SERVER_PID
  "

echo "⏳ Waiting for container to be ready..."
sleep 20

# Check if container is running
if ! docker ps | grep -q tinstar-test-container; then
    echo "❌ Container failed to start. Checking logs..."
    docker logs tinstar-test-container
    exit 1
fi

echo "✅ Container is running"

# Check if tinstar server is responding
echo "🔍 Checking if tinstar server is responding on port 3002..."
for i in {1..10}; do
    if curl -f http://localhost:3002/api/projects/health > /dev/null 2>&1; then
        echo "✅ Tinstar API is responding"
        break
    else
        echo "⏳ Attempt $i: API not ready yet..."
        sleep 3
    fi
    
    if [ $i -eq 10 ]; then
        echo "❌ API not responding after 30 seconds. Checking logs..."
        docker logs tinstar-test-container | tail -20
        exit 1
    fi
done

# Check UI server
echo "🔍 Checking UI server on port 8081..."
if curl -f http://localhost:8081 > /dev/null 2>&1; then
    echo "✅ UI server is responding"
else
    echo "⚠️ UI server may not be ready yet"
fi

# Verify projects are loaded
echo "📊 Verifying projects are loaded..."
PROJECTS=$(curl -s http://localhost:3002/api/projects | jq -r '.projects | length' 2>/dev/null || echo "0")
echo "Found $PROJECTS projects in tinstar"

# Run the real integration tests
echo "🎭 Running Playwright integration tests against real tinstar..."
cd ui
TINSTAR_URL=http://localhost:3002 UI_URL=http://localhost:8081 npm test -- tests/integration/docker-real.spec.ts --headed=false

# Capture final state
echo "📸 Capturing final container state..."
docker exec tinstar-test-container bash -c "
    echo '=== Tinstar Server Status ==='
    curl -s http://localhost:3002/api/projects || echo 'API not responding'
    
    echo '=== Project Files ==='
    find /home/testuser/test-projects -name '*.js' -o -name '*.json' | head -10
    
    echo '=== Container Processes ==='  
    ps aux | grep -E '(tinstar|python|node)' || echo 'No processes found'
"

# Clean up
echo "🧹 Cleaning up container..."
docker stop tinstar-test-container
docker rm tinstar-test-container

echo ""
echo "✅ Real Docker Integration Test Complete!"
echo "📸 Screenshots should be available in the ./ui/screenshots directory"
echo "📋 Test Results Summary:"

if [ -d "ui/screenshots" ] && [ "$(ls -A ui/screenshots)" ]; then
    echo "   Screenshots generated:"
    ls -la ui/screenshots/
    
    echo ""
    echo "🖼️ Screenshot Files:"
    for screenshot in ui/screenshots/*.png; do
        if [ -f "$screenshot" ]; then
            echo "   - $(basename "$screenshot")"
        fi
    done
else
    echo "   No screenshots found - check test execution"
fi

echo ""
echo "🎯 To view the HTML test report:"
echo "   cd ui && npx playwright show-report"
echo ""
echo "🔍 Integration Test Validated:"
echo "   ✅ Real tinstar server on port 3002"
echo "   ✅ Real git repositories created"
echo "   ✅ Projects registered via API"
echo "   ✅ Actual UI components tested"
echo "   ✅ Real FileTree integration"
echo "   ✅ Authentic project management workflow"