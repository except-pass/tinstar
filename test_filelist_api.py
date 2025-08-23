#!/usr/bin/env python3
"""
Simple test script to verify filelist API endpoints work.
"""
import os
import sys
import tempfile
import subprocess
import json
from pathlib import Path

# Add the project root to Python path
sys.path.insert(0, str(Path(__file__).parent))

from tinstar.server import create_tinstar_app
from tinstar.projects.service import ProjectService
from tinstar.projects.models import CreateProjectRequest

def create_test_project():
    """Create a test project with some files."""
    # Create temporary directory with git repo
    test_dir = tempfile.mkdtemp(prefix="test_project_")
    test_path = Path(test_dir)
    
    # Initialize git repo
    subprocess.run(["git", "init"], cwd=test_path, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=test_path, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=test_path, check=True)
    
    # Create some test files
    (test_path / "README.md").write_text("# Test Project\n\nThis is a test project.")
    (test_path / "src").mkdir()
    (test_path / "src" / "main.py").write_text("print('Hello, world!')")
    (test_path / "src" / "utils.py").write_text("def helper(): pass")
    (test_path / "src" / "components").mkdir()
    (test_path / "src" / "components" / "widget.py").write_text("class Widget: pass")
    
    # Add and commit files
    subprocess.run(["git", "add", "."], cwd=test_path, check=True)
    subprocess.run(["git", "commit", "-m", "Initial commit"], cwd=test_path, check=True)
    
    return str(test_path)

def test_api_endpoints():
    """Test the filelist API endpoints."""
    # Create test project
    project_path = create_test_project()
    print(f"Created test project at: {project_path}")
    
    # Register project with projects service
    projects_service = ProjectService()
    request = CreateProjectRequest(
        path=project_path,
        name="test_project"
    )
    project = projects_service.create_project(request)
    print(f"Registered project: {project.name}")
    
    # Test the filelist API
    app = create_tinstar_app()
    from fastapi.testclient import TestClient
    client = TestClient(app)
    
    # Test file tree endpoint
    response = client.post(
        "/filelist/test_project/tree",
        json={"open_dirs": [""]}
    )
    
    print(f"API Response Status: {response.status_code}")
    
    if response.status_code == 200:
        tree_data = response.json()
        print("✅ File tree API working!")
        print("Tree structure:")
        print(json.dumps(tree_data, indent=2))
    else:
        print(f"❌ API Error: {response.text}")
        return False
    
    # Cleanup
    import shutil
    shutil.rmtree(project_path)
    projects_service.delete_project("test_project")
    
    return True

if __name__ == "__main__":
    print("Testing Filelist API...")
    success = test_api_endpoints()
    print("✅ All tests passed!" if success else "❌ Tests failed!")
    sys.exit(0 if success else 1)