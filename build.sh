#!/usr/bin/env bash

# Exit on error
set -o errexit

STORAGE_DIR=/opt/render/project/.render

if [[ ! -d $STORAGE_DIR/chrome ]]; then
  echo "...Downloading Chrome"
  mkdir -p $STORAGE_DIR/chrome
  cd $STORAGE_DIR/chrome
  wget -P ./ https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  dpkg -x ./google-chrome-stable_current_amd64.deb $STORAGE_DIR/chrome
  rm ./google-chrome-stable_current_amd64.deb
  echo "Chrome downloaded and extracted successfully"
else
  echo "...Using Chrome from cache"
fi

# Return to project directory
cd /opt/render/project/src

# Install npm dependencies
echo "Installing npm dependencies..."
npm ci --only=production

echo "Build completed successfully!"