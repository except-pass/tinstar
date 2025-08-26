#!/bin/bash
set -e

echo "🚀 Setting up Docker integration test environment..."

# Create test directories in container
TEST_DIR="/home/testuser/test-projects"
mkdir -p "$TEST_DIR"

echo "📁 Creating test git repositories..."

# Create sample frontend project
FRONTEND_DIR="$TEST_DIR/sample-frontend"
mkdir -p "$FRONTEND_DIR"
cd "$FRONTEND_DIR"

# Initialize git repo
git init
git config user.name "Test User"
git config user.email "test@example.com"

# Create frontend project structure
mkdir -p src/components src/hooks public docs/api

# Create sample files
cat > package.json << 'EOF'
{
  "name": "sample-frontend",
  "version": "1.0.0",
  "description": "A sample frontend project for testing",
  "main": "src/index.js",
  "scripts": {
    "start": "react-scripts start",
    "build": "react-scripts build",
    "test": "react-scripts test"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  }
}
EOF

cat > src/App.js << 'EOF'
import React from 'react';
import './App.css';

function App() {
  return (
    <div className="App">
      <header className="App-header">
        <h1>Sample Frontend App</h1>
        <p>This is a test application for tinstar integration testing.</p>
      </header>
    </div>
  );
}

export default App;
EOF

cat > src/index.js << 'EOF'
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
EOF

cat > src/components/Button.js << 'EOF'
import React from 'react';

const Button = ({ children, onClick, className = '' }) => {
  return (
    <button 
      className={`btn ${className}`} 
      onClick={onClick}
    >
      {children}
    </button>
  );
};

export default Button;
EOF

cat > src/components/Header.js << 'EOF'
import React from 'react';

const Header = ({ title, subtitle }) => {
  return (
    <header>
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
    </header>
  );
};

export default Header;
EOF

cat > src/hooks/useCounter.js << 'EOF'
import { useState, useCallback } from 'react';

export const useCounter = (initialValue = 0) => {
  const [count, setCount] = useState(initialValue);
  
  const increment = useCallback(() => setCount(c => c + 1), []);
  const decrement = useCallback(() => setCount(c => c - 1), []);
  const reset = useCallback(() => setCount(initialValue), [initialValue]);
  
  return { count, increment, decrement, reset };
};
EOF

cat > public/index.html << 'EOF'
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Sample Frontend</title>
</head>
<body>
    <div id="root"></div>
</body>
</html>
EOF

cat > docs/api/README.md << 'EOF'
# API Documentation

## Overview
This document describes the API endpoints for the sample frontend application.

## Endpoints

### GET /api/users
Returns a list of users.

### POST /api/users
Creates a new user.
EOF

cat > README.md << 'EOF'
# Sample Frontend

A React application for testing the tinstar project management system.

## Features
- React components
- Custom hooks
- Modern project structure

## Getting Started
```bash
npm install
npm start
```
EOF

cat > .gitignore << 'EOF'
node_modules/
build/
.env.local
.env.development.local
.env.test.local
.env.production.local
npm-debug.log*
yarn-debug.log*
yarn-error.log*
EOF

# Commit initial files
git add .
git commit -m "Initial frontend project setup"

echo "✅ Frontend project created at $FRONTEND_DIR"

# Create sample backend project
BACKEND_DIR="$TEST_DIR/sample-backend"
mkdir -p "$BACKEND_DIR"
cd "$BACKEND_DIR"

# Initialize git repo
git init
git config user.name "Test User"
git config user.email "test@example.com"

# Create backend project structure
mkdir -p src/routes src/models src/middleware config tests/unit tests/integration

# Create sample files
cat > package.json << 'EOF'
{
  "name": "sample-backend",
  "version": "1.0.0",
  "description": "A sample backend API for testing",
  "main": "src/server.js",
  "scripts": {
    "start": "node src/server.js",
    "dev": "nodemon src/server.js",
    "test": "jest"
  },
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "morgan": "^1.10.0"
  },
  "devDependencies": {
    "nodemon": "^2.0.20",
    "jest": "^29.0.0"
  }
}
EOF

cat > src/server.js << 'EOF'
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const userRoutes = require('./routes/users');
const projectRoutes = require('./routes/projects');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(morgan('combined'));
app.use(express.json());

// Routes
app.use('/api/users', userRoutes);
app.use('/api/projects', projectRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
EOF

cat > src/routes/users.js << 'EOF'
const express = require('express');
const router = express.Router();

// Mock user data
const users = [
  { id: 1, name: 'John Doe', email: 'john@example.com' },
  { id: 2, name: 'Jane Smith', email: 'jane@example.com' }
];

// GET /api/users
router.get('/', (req, res) => {
  res.json(users);
});

// POST /api/users
router.post('/', (req, res) => {
  const { name, email } = req.body;
  const newUser = {
    id: users.length + 1,
    name,
    email
  };
  users.push(newUser);
  res.status(201).json(newUser);
});

// GET /api/users/:id
router.get('/:id', (req, res) => {
  const user = users.find(u => u.id === parseInt(req.params.id));
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json(user);
});

module.exports = router;
EOF

cat > src/routes/projects.js << 'EOF'
const express = require('express');
const router = express.Router();

// Mock project data
const projects = [
  { id: 1, name: 'Frontend App', status: 'active' },
  { id: 2, name: 'Backend API', status: 'development' }
];

// GET /api/projects
router.get('/', (req, res) => {
  res.json(projects);
});

// POST /api/projects
router.post('/', (req, res) => {
  const { name, status = 'development' } = req.body;
  const newProject = {
    id: projects.length + 1,
    name,
    status
  };
  projects.push(newProject);
  res.status(201).json(newProject);
});

module.exports = router;
EOF

cat > src/models/User.js << 'EOF'
class User {
  constructor(id, name, email) {
    this.id = id;
    this.name = name;
    this.email = email;
    this.createdAt = new Date();
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      email: this.email,
      createdAt: this.createdAt
    };
  }
}

module.exports = User;
EOF

cat > config/database.js << 'EOF'
module.exports = {
  development: {
    host: 'localhost',
    port: 5432,
    database: 'sample_dev',
    username: 'dev_user',
    password: 'dev_password'
  },
  test: {
    host: 'localhost',
    port: 5432,
    database: 'sample_test',
    username: 'test_user',
    password: 'test_password'
  },
  production: {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD
  }
};
EOF

cat > tests/unit/user.test.js << 'EOF'
const User = require('../../src/models/User');

describe('User Model', () => {
  test('creates user with correct properties', () => {
    const user = new User(1, 'Test User', 'test@example.com');
    
    expect(user.id).toBe(1);
    expect(user.name).toBe('Test User');
    expect(user.email).toBe('test@example.com');
    expect(user.createdAt).toBeInstanceOf(Date);
  });

  test('toJSON returns correct format', () => {
    const user = new User(1, 'Test User', 'test@example.com');
    const json = user.toJSON();
    
    expect(json).toHaveProperty('id', 1);
    expect(json).toHaveProperty('name', 'Test User');
    expect(json).toHaveProperty('email', 'test@example.com');
    expect(json).toHaveProperty('createdAt');
  });
});
EOF

cat > README.md << 'EOF'
# Sample Backend

A Node.js Express API for testing the tinstar project management system.

## Features
- Express server
- REST API endpoints
- Unit tests with Jest
- Environment configuration

## Getting Started
```bash
npm install
npm run dev
```

## API Endpoints
- GET /health - Health check
- GET /api/users - List users
- POST /api/users - Create user
- GET /api/projects - List projects
EOF

cat > .gitignore << 'EOF'
node_modules/
.env
.env.local
.env.development.local
.env.test.local
.env.production.local
npm-debug.log*
yarn-debug.log*
yarn-error.log*
coverage/
EOF

# Commit initial files
git add .
git commit -m "Initial backend project setup"

echo "✅ Backend project created at $BACKEND_DIR"

# Create a simple library project
LIBRARY_DIR="$TEST_DIR/sample-library"
mkdir -p "$LIBRARY_DIR"
cd "$LIBRARY_DIR"

# Initialize git repo
git init
git config user.name "Test User"
git config user.email "test@example.com"

# Create library structure
mkdir -p lib tests examples docs

cat > package.json << 'EOF'
{
  "name": "sample-library",
  "version": "1.0.0",
  "description": "A sample JavaScript library for testing",
  "main": "lib/index.js",
  "scripts": {
    "test": "jest",
    "build": "babel src -d lib"
  },
  "keywords": ["utility", "library", "testing"],
  "author": "Test User",
  "license": "MIT"
}
EOF

cat > lib/index.js << 'EOF'
/**
 * Sample utility library
 */

/**
 * Formats a string with proper capitalization
 * @param {string} str - The string to format
 * @returns {string} The formatted string
 */
function formatString(str) {
  if (!str || typeof str !== 'string') {
    return '';
  }
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

/**
 * Calculates the sum of an array of numbers
 * @param {number[]} numbers - Array of numbers
 * @returns {number} The sum
 */
function sum(numbers) {
  if (!Array.isArray(numbers)) {
    return 0;
  }
  return numbers.reduce((total, num) => total + (typeof num === 'number' ? num : 0), 0);
}

/**
 * Debounces a function call
 * @param {Function} func - The function to debounce
 * @param {number} delay - Delay in milliseconds
 * @returns {Function} The debounced function
 */
function debounce(func, delay) {
  let timeoutId;
  return function(...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => func.apply(this, args), delay);
  };
}

module.exports = {
  formatString,
  sum,
  debounce
};
EOF

cat > tests/library.test.js << 'EOF'
const { formatString, sum, debounce } = require('../lib/index');

describe('Sample Library', () => {
  describe('formatString', () => {
    test('capitalizes first letter', () => {
      expect(formatString('hello')).toBe('Hello');
    });

    test('handles empty string', () => {
      expect(formatString('')).toBe('');
    });

    test('handles non-string input', () => {
      expect(formatString(null)).toBe('');
      expect(formatString(123)).toBe('');
    });
  });

  describe('sum', () => {
    test('calculates sum of numbers', () => {
      expect(sum([1, 2, 3, 4])).toBe(10);
    });

    test('handles empty array', () => {
      expect(sum([])).toBe(0);
    });

    test('ignores non-numeric values', () => {
      expect(sum([1, 'a', 2, null, 3])).toBe(6);
    });
  });

  describe('debounce', () => {
    jest.useFakeTimers();

    test('delays function execution', () => {
      const mockFn = jest.fn();
      const debouncedFn = debounce(mockFn, 100);

      debouncedFn();
      expect(mockFn).not.toHaveBeenCalled();

      jest.advanceTimersByTime(100);
      expect(mockFn).toHaveBeenCalledTimes(1);
    });
  });
});
EOF

cat > examples/usage.js << 'EOF'
const { formatString, sum, debounce } = require('../lib/index');

// Example usage of the library
console.log('formatString example:');
console.log(formatString('hello world')); // "Hello world"

console.log('\nsum example:');
console.log(sum([1, 2, 3, 4, 5])); // 15

console.log('\ndebounce example:');
const debouncedLog = debounce(() => console.log('Debounced!'), 300);
debouncedLog();
debouncedLog();
debouncedLog(); // Only this will execute after 300ms
EOF

cat > README.md << 'EOF'
# Sample Library

A simple JavaScript utility library for testing purposes.

## Installation
```bash
npm install sample-library
```

## Usage
```javascript
const { formatString, sum, debounce } = require('sample-library');

// Format strings
const formatted = formatString('hello world'); // "Hello world"

// Calculate sums
const total = sum([1, 2, 3, 4]); // 10

// Debounce function calls
const debouncedFn = debounce(() => console.log('Called!'), 300);
```

## API
- `formatString(str)` - Formats a string with proper capitalization
- `sum(numbers)` - Calculates the sum of an array of numbers  
- `debounce(func, delay)` - Creates a debounced version of a function
EOF

# Commit initial files
git add .
git commit -m "Initial library setup with utilities and tests"

echo "✅ Library project created at $LIBRARY_DIR"

echo "🎯 Test repositories created successfully:"
echo "   - $FRONTEND_DIR (React frontend)"
echo "   - $BACKEND_DIR (Node.js API)"
echo "   - $LIBRARY_DIR (JavaScript library)"

echo ""
echo "📊 Repository structure:"
for dir in "$FRONTEND_DIR" "$BACKEND_DIR" "$LIBRARY_DIR"; do
  echo "  $(basename "$dir"):"
  cd "$dir"
  find . -type f -name "*.js" -o -name "*.json" -o -name "*.md" | head -10 | sed 's/^/    /'
  if [ $(find . -type f | wc -l) -gt 10 ]; then
    echo "    ... and $(( $(find . -type f | wc -l) - 10 )) more files"
  fi
  echo ""
done

echo "🚀 Ready for tinstar integration testing!"