#!/bin/bash
cd "$(dirname "$0")"

echo ""
echo "========================================"
echo "  Photo Scanner - Building installer..."
echo "========================================"
echo ""

# Check Node
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js is not installed."
    echo ""
    echo "Please download and install Node.js from:"
    echo "https://nodejs.org  (click the LTS version)"
    echo ""
    echo "After installing, double-click BUILD-MAC.command again."
    read -p "Press Enter to exit..."
    exit 1
fi

echo "Node.js found. Installing dependencies..."
npm install
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to install dependencies."
    read -p "Press Enter to exit..."
    exit 1
fi

echo ""
echo "Building Mac installer..."
npm run build-mac
if [ $? -ne 0 ]; then
    echo "ERROR: Build failed."
    read -p "Press Enter to exit..."
    exit 1
fi

echo ""
echo "========================================"
echo "  SUCCESS!"
echo "  Your installer is in the dist/ folder"
echo "  Look for: Photo Scanner.dmg"
echo "========================================"
echo ""
open dist
read -p "Press Enter to exit..."
