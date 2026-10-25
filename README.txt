PHOTO SCANNER  (version 2)
==========================

What it does
  Drop in scanned pages (any number). For every page it finds each separate photo,
  straightens it, cuts off the white border / scanner background, and saves it as
  its own JPG. Nothing to adjust. Photos are saved to  Pictures\Photo Scanner
  (you can change the folder inside the app).

How to update your existing build (Windows)
  1. Close the app. In your photo-scanner-app folder, replace these files with the new ones:
       index.html, main.js, preload.js, package.json, engine.js, worker.js
  2. Double-click BUILD-WINDOWS.bat  (or run:  npm run build-win )
  3. Install the new .exe from the "dist" folder.

Pages marked "worth a quick look" are ones where the program was less sure.
Click the page to see coloured outlines of what it found.
