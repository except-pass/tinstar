#!/bin/bash
set -e

echo "🐳 Starting Docker Integration Test for Tinstar Project Pane"
echo "============================================================"

# Create screenshots directory on host
mkdir -p screenshots

# Build the Docker image
echo "📦 Building Docker image..."
docker build -t tinstar-test .

# Run the container with test setup
echo "🚀 Starting container and setting up test environment..."
docker run -d \
  --name tinstar-test-container \
  -p 8000:8000 \
  -v "$(pwd)/screenshots:/home/testuser/screenshots" \
  tinstar-test bash -c "
    # Run the test setup script
    bash /home/testuser/tinstar/docker-test-setup.sh
    
    # Start tinstar server in background
    cd /home/testuser/tinstar
    python -m tinstar.server --host 0.0.0.0 --port 8000 &
    
    # Wait for server to start
    sleep 10
    
    # Keep container running
    tail -f /dev/null
  "

echo "⏳ Waiting for container to be ready..."
sleep 15

# Check if container is running
if ! docker ps | grep -q tinstar-test-container; then
    echo "❌ Container failed to start. Checking logs..."
    docker logs tinstar-test-container
    exit 1
fi

echo "✅ Container is running"

# Check if server is responding
echo "🔍 Checking if tinstar server is responding..."
if curl -f http://localhost:8000/api/projects/health > /dev/null 2>&1; then
    echo "✅ Tinstar API is responding"
else
    echo "⚠️  API not responding yet, checking container status..."
    docker logs tinstar-test-container | tail -20
fi

# Run the Playwright tests against the Docker container
echo "🎭 Running Playwright integration tests..."
cd ui
TINSTAR_URL=http://localhost:8000 npm test -- tests/integration/docker-e2e.spec.ts --headed

# Copy screenshots from container to host
echo "📸 Copying screenshots from container..."
docker exec tinstar-test-container bash -c "
    # Create screenshots in container if any were generated
    mkdir -p /home/testuser/screenshots
    
    # If project pane generated any screenshots during testing, they'll be here
    # The Playwright test should save them to the mounted volume
"

# Clean up
echo "🧹 Cleaning up container..."
docker stop tinstar-test-container
docker rm tinstar-test-container

echo ""
echo "✅ Docker Integration Test Complete!"
echo "📸 Screenshots should be available in the ./screenshots directory"
echo "📋 Test Results:"

if [ -d "screenshots" ] && [ "$(ls -A screenshots)" ]; then
    echo "   Screenshots generated:"
    ls -la screenshots/
else
    echo "   No screenshots found - check test execution"
fi

echo ""
echo "🎯 To view the HTML test report:"
echo "   cd ui && npx playwright show-report"