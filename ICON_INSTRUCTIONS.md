# Icon Generation Instructions

The extension references three PNG icon files in the manifest.json:

- `icon16.png` (16x16 pixels)
- `icon48.png` (48x48 pixels)
- `icon128.png` (128x128 pixels)

These files are not included in the repository. To generate them:

1. Use the provided `icon.svg` file as the source
2. Convert it to PNG format at the required sizes using one of these methods:

## Method 1: Using Inkscape (Command Line)

```bash
# Install Inkscape if not already installed
# On Mac: brew install inkscape
# On Ubuntu: sudo apt-get install inkscape

# Generate the icons
inkscape -w 16 -h 16 icon.svg -o icon16.png
inkscape -w 48 -h 48 icon.svg -o icon48.png
inkscape -w 128 -h 128 icon.svg -o icon128.png
```

## Method 2: Using Online Converter

1. Go to an online SVG to PNG converter (e.g., CloudConvert, Online-Convert)
2. Upload the `icon.svg` file
3. Set the output size to 16x16, 48x48, and 128x128 pixels respectively
4. Download the generated PNG files

## Method 3: Using Design Software

1. Open `icon.svg` in your preferred design software (Figma, Adobe Illustrator, GIMP, etc.)
2. Export as PNG at the required sizes
3. Save as `icon16.png`, `icon48.png`, and `icon128.png`

## Alternative: Temporary Icon Files

For testing purposes, you can create simple placeholder images:

- Create 16x16, 48x48, and 128x128 pixel images
- Use any simple design or solid color
- Name them appropriately and place in the extension root directory

The extension will work without these icons, but they improve the user experience in the Chrome extensions page and
toolbar.
