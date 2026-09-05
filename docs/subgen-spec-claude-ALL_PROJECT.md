SubGen - Complete Project Files

> **Not the tool in `subgen/`.** This is a specification that was never
> implemented, kept for the design decisions in it. The generator that exists
> is `subgen/src/`, which is faster-whisper based and documented in
> `subgen/README.md`; nothing below describes its behaviour, its flags or its
> output. See the root README's "What subgen is" list.

Copy each file below to create your project structure.

File: README.md
markdown
# Local Subtitle Generator (SubGen)

A production-grade, privacy-first subtitle generation system for MacBook Pro (M1/M2/M3). Generates accurate subtitles from video/audio files using OpenAI's Whisper model, running 100% locally on your machine.

## Features

- **Fully Local Processing**: No cloud APIs, no data leaves your machine
- **Dual-Mode Output**: Generate subtitles in both original language and English
- **High Accuracy**: Uses Whisper `large-v3` model optimized for non-native accents
- **Voice Activity Detection**: Prevents hallucinations during silence
- **Domain-Specific Vocabulary**: Custom glossary support for technical terms
- **Apple Silicon Optimized**: Efficient CPU inference using int8 quantization
- **Multiple Format Support**: MP4, MKV, MOV, AVI, WAV, MP3, M4A, and more

## System Requirements

- **Hardware**: MacBook Pro with M1/M2/M3 chip
- **OS**: macOS 11.0 or later
- **Python**: 3.10 or 3.11
- **External Dependency**: ffmpeg (for audio extraction)
- **Storage**: ~3GB for large-v3 model + cache

## Quick Start

### 1. Install ffmpeg
```bash
brew install ffmpeg
```

### 2. Clone and Setup
```bash
git clone  subgen
cd subgen
chmod +x setup.sh run.sh
./setup.sh
```

The setup script will:
- Check for Python 3.10/3.11
- Create a virtual environment
- Install all dependencies
- Validate ffmpeg installation

### 3. Run Your First Transcription
```bash
# Process a video file (generates both .orig.srt and .en.srt)
./run.sh inputs/meeting.mp4

# Transcribe only (original language)
./run.sh --mode transcribe inputs/lecture.mkv

# Translate only (English)
./run.sh --mode translate inputs/podcast.mp3
```

## Usage

### Basic Commands
```bash
# Default: generate both original and English subtitles
./run.sh path/to/video.mp4

# Specify output directory
./run.sh --output-dir my_subs inputs/video.mp4

# Use a smaller/faster model
./run.sh --model-size medium inputs/video.mp4

# Use custom glossary
./run.sh --glossary my_terms.txt inputs/video.mp4
```

### Processing Modes

- **`both`** (default): Creates `filename.orig.srt` + `filename.en.srt`
- **`transcribe`**: Original language only → `filename.orig.srt`
- **`translate`**: English translation only → `filename.en.srt`

### Supported File Formats

**Video**: MP4, MKV, MOV, AVI, WEBM, FLV  
**Audio**: WAV, MP3, M4A, AAC, FLAC, OGG

### Custom Glossary

Edit `src/glossary.txt` to add technical terms specific to your domain:
```text
Kubernetes
Apache Spark
Contoso
TensorFlow
PostgreSQL
```

The system will inject these terms into the model's context to improve recognition accuracy.

## Performance Expectations

On M1 Max with `large-v3` and `int8` quantization:

- **1-hour video**: ~45-75 minutes processing time
- **CPU usage**: 60-80% (utilizes all efficiency + performance cores)
- **Memory**: ~4-6GB RAM
- **First run**: Additional 10-15 minutes for model download

## Project Structure
subgen/ ├── inputs/ # Place your video/audio files here (not tracked) ├── outputs/ # Generated subtitle files (not tracked) ├── models/ # Cached Whisper models (not tracked) ├── src/ │ ├── init.py │ ├── cli.py # Command-line interface │ ├── engine.py # Whisper model wrapper with VAD │ ├── utils.py # SRT formatting and file utilities │ └── glossary.txt # Default technical vocabulary ├── requirements.txt ├── setup.sh # One-time setup script ├── run.sh # Convenience wrapper for CLI ├── .gitignore └── README.md


## Advanced Configuration

### Model Size Options

| Model | Parameters | Accuracy | Speed | Memory (int8) |
|-------|-----------|----------|-------|---------------|
| tiny | 39M | Low | Very Fast | ~1GB |
| base | 74M | Fair | Fast | ~1GB |
| small | 244M | Good | Medium | ~2GB |
| medium | 769M | Very Good | Slow | ~3GB |
| large-v3 | 1550M | Excellent | Slower | ~4GB |

## Troubleshooting

### "ffmpeg not found"
```bash
brew install ffmpeg
# Verify installation
ffmpeg -version
```

### Model Download Fails

Check your internet connection. Models are downloaded once from Hugging Face Hub and cached locally.

### Out of Memory

- Try a smaller model: `--model-size medium`
- Close other applications
- Check Activity Monitor for memory pressure

### Inaccurate Transcription

1. Update `src/glossary.txt` with domain-specific terms
2. Ensure audio quality is good (clear speech, minimal background noise)
3. Consider using `large-v3` for maximum accuracy

## Privacy & Security

- **Zero Data Transmission**: All processing happens locally
- **No Telemetry**: No usage statistics collected
- **No API Keys**: No third-party services required
- **Internet Usage**: Only for downloading models during setup

## Technical Details

### Why faster-whisper?

- CTranslate2 backend provides 4x speed improvement
- Lower memory footprint
- Built-in VAD support
- Production-ready and actively maintained

### Why CPU + int8?

- M1 Neural Engine not directly accessible via PyTorch
- int8 quantization optimal for M1 CPU architecture
- Balances speed and accuracy effectively
- More stable than GPU/MPS backend

## License

This project uses:
- faster-whisper (MIT License)
- OpenAI Whisper models (MIT License)
- Silero VAD (MIT License)
File: requirements.txt
# Core dependencies for SubGen - Local Subtitle Generator
# Optimized for Apple Silicon (M1/M2/M3)

# Faster Whisper - Optimized Whisper implementation with CTranslate2
faster-whisper==1.1.0

# Audio processing
ffmpeg-python==0.2.0

# Progress bars for better UX
tqdm==4.66.1

# Note: No additional dependencies needed for CLI (using stdlib argparse)
File: setup.sh
bash
#!/usr/bin/env bash

# SubGen Setup Script
# Sets up Python virtual environment and installs dependencies

set -e  # Exit on error

echo "=========================================="
echo "SubGen - Local Subtitle Generator Setup"
echo "=========================================="
echo ""

# Check for Python 3
if ! command -v python3 &> /dev/null; then
    echo "❌ Error: python3 not found"
    echo "Please install Python 3.10 or 3.11 from python.org or using Homebrew:"
    echo "  brew install python@3.11"
    exit 1
fi

# Check Python version
PYTHON_VERSION=$(python3 --version 2>&1 | awk '{print $2}')
PYTHON_MAJOR=$(echo "$PYTHON_VERSION" | cut -d. -f1)
PYTHON_MINOR=$(echo "$PYTHON_VERSION" | cut -d. -f2)

echo "✓ Found Python $PYTHON_VERSION"

if [ "$PYTHON_MAJOR" -lt 3 ] || ([ "$PYTHON_MAJOR" -eq 3 ] && [ "$PYTHON_MINOR" -lt 10 ]); then
    echo "⚠️  Warning: Python 3.10 or higher is recommended"
    echo "   Your version: $PYTHON_VERSION"
    echo "   Installation may still work but is not tested"
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Check for ffmpeg
echo ""
echo "Checking for ffmpeg..."
if ! command -v ffmpeg &> /dev/null; then
    echo "❌ Error: ffmpeg not found"
    echo ""
    echo "ffmpeg is required for audio extraction from video files."
    echo "Please install it using Homebrew:"
    echo ""
    echo "  brew install ffmpeg"
    echo ""
    echo "After installation, run this setup script again."
    exit 1
fi

FFMPEG_VERSION=$(ffmpeg -version 2>&1 | head -n1 | awk '{print $3}')
echo "✓ Found ffmpeg $FFMPEG_VERSION"

# Create directories
echo ""
echo "Creating project directories..."
mkdir -p inputs
mkdir -p outputs
mkdir -p models
echo "✓ Created inputs/, outputs/, models/"

# Create or update virtual environment
echo ""
if [ -d ".venv" ]; then
    echo "Virtual environment already exists, updating..."
else
    echo "Creating virtual environment..."
    python3 -m venv .venv
fi

# Activate virtual environment
echo "Activating virtual environment..."
source .venv/bin/activate

# Upgrade pip
echo ""
echo "Upgrading pip..."
python -m pip install --upgrade pip --quiet

# Install dependencies
echo ""
echo "Installing Python dependencies..."
echo "(This may take a few minutes on first install)"
pip install -r requirements.txt

# Validate installation
echo ""
echo "Validating installation..."
python -c "from faster_whisper import WhisperModel; print('✓ faster-whisper imported successfully')"
python -c "import ffmpeg; print('✓ ffmpeg-python imported successfully')"
python -c "import tqdm; print('✓ tqdm imported successfully')"

echo ""
echo "=========================================="
echo "✅ Setup complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo "  1. Place your video/audio files in the 'inputs/' directory"
echo "  2. Run: ./run.sh inputs/your_file.mp4"
echo ""
echo "For more options: ./run.sh --help"
echo ""
echo "Note: On first run, the Whisper model (~3GB) will be"
echo "downloaded and cached. This is a one-time operation."
echo ""
File: run.sh
bash
#!/usr/bin/env bash

# SubGen CLI Wrapper
# Activates virtual environment and runs the CLI

set -e

# Check if virtual environment exists
if [ ! -d ".venv" ]; then
    echo "❌ Error: Virtual environment not found"
    echo "Please run ./setup.sh first"
    exit 1
fi

# Activate virtual environment
source .venv/bin/activate

# Run the CLI with all arguments
python -m src.cli "$@"
File: .gitignore
# Python
__pycache__/
*.py[cod]
*$py.class
*.so
.Python

# Virtual Environment
.venv/
venv/
ENV/
env/

# Project-specific directories
inputs/
outputs/
models/

# IDE
.vscode/
.idea/
*.swp
*.swo
*~

# OS
.DS_Store
Thumbs.db

# Logs
*.log

# Distribution / packaging
dist/
build/
*.egg-info/
File: src/__init__.py
python
"""
SubGen - Local Subtitle Generator
A privacy-first subtitle generation system for Apple Silicon Macs
"""

__version__ = "1.0.0"
__author__ = "SubGen Project"
File: src/cli.py
python
#!/usr/bin/env python3
"""
Command-line interface for SubGen
"""

import argparse
import sys
from pathlib import Path
from typing import List

from .engine import SubGenEngine
from .utils import validate_input_file, get_supported_extensions


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        prog="subgen",
        description="Local subtitle generator for video/audio files",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s inputs/meeting.mp4
  %(prog)s --mode translate inputs/lecture.mkv
  %(prog)s --model-size medium --output-dir subs inputs/podcast.mp3
  %(prog)s --glossary my_terms.txt inputs/video.mp4

Supported formats:
  Video: mp4, mkv, mov, avi, webm, flv
  Audio: wav, mp3, m4a, aac, flac, ogg
        """
    )
    
    parser.add_argument(
        "input_path",
        type=str,
        help="Path to input video or audio file"
    )
    
    parser.add_argument(
        "--mode",
        type=str,
        choices=["transcribe", "translate", "both"],
        default="both",
        help="Processing mode (default: both)"
    )
    
    parser.add_argument(
        "--model-size",
        type=str,
        choices=["tiny", "base", "small", "medium", "large-v3", "large-v2"],
        default="large-v3",
        help="Whisper model size (default: large-v3)"
    )
    
    parser.add_argument(
        "--output-dir",
        type=str,
        default="outputs",
        help="Output directory for subtitle files (default: outputs)"
    )
    
    parser.add_argument(
        "--glossary",
        type=str,
        default="src/glossary.txt",
        help="Path to glossary file (default: src/glossary.txt)"
    )
    
    parser.add_argument(
        "--device",
        type=str,
        choices=["cpu", "cuda", "auto"],
        default="cpu",
        help="Device to use (default: cpu for M1)"
    )
    
    parser.add_argument(
        "--compute-type",
        type=str,
        choices=["int8", "int8_float16", "float16", "float32"],
        default="int8",
        help="Computation type (default: int8 for M1)"
    )
    
    parser.add_argument(
        "--no-vad",
        action="store_true",
        help="Disable voice activity detection"
    )
    
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable verbose output"
    )
    
    return parser.parse_args()


def main() -> int:
    """Main entry point."""
    args = parse_args()
    
    # Validate input file
    input_path = Path(args.input_path)
    if not validate_input_file(input_path):
        print(f"✓ Audio extracted to temporary file")
        return temp_audio_path
        
    except Exception as e:
        # Clean up temp file on error
        if Path(temp_audio_path).exists():
            Path(temp_audio_path).unlink()
        raise RuntimeError(f"Failed to extract audio: {e}")


def cleanup_temp_audio(audio_path: str, original_path: str) -> None:
    """
    Clean up temporary audio file if it was created.
    
    Args:
        audio_path: Path to audio file (might be temp)
        original_path: Original input path
    """
    if audio_path != original_path and Path(audio_path).exists():
        try:
            Path(audio_path).unlink()
        except Exception:
            pass  # Best effort cleanup
File: src/glossary.txt
# SubGen Glossary
# Add technical terms, acronyms, and product names here (one per line)
# These terms will be included in the model's context to improve recognition

# Cloud & Infrastructure
Kubernetes
Docker
Terraform
AWS
Azure
Google Cloud
GCP

# Big Data & Analytics
Apache Spark
Hadoop
Kafka
Flink
Hive
Presto
Databricks

# Databases
PostgreSQL
MongoDB
Cassandra
Redis
Elasticsearch

# AI & ML
TensorFlow
PyTorch
scikit-learn
CUDA
GPU

# Contoso Products (example)
Contoso
CloudTable
FusionInsight
OBS
ModelArts

# General Tech Terms
API
REST
GraphQL
microservices
DevOps
CI/CD
MLOps

# Add your own terms below:
# (Remove this line and add actual terms)
Setup Instructions
Create the project directory:
bash
mkdir subgen
cd subgen
Copy all the files above into their respective locations:
Root files: README.md, requirements.txt, setup.sh, run.sh, .gitignore
Create src/ directory and add all Python files
Make sure src/glossary.txt is created
Make scripts executable:
bash
chmod +x setup.sh run.sh
Install ffmpeg (if not already installed):
bash
brew install ffmpeg
Run setup:
bash
./setup.sh
Test the system:
bash
# Place a video/audio file in inputs/ directory
./run.sh inputs/your_file.mp4
Quick Copy Commands
After creating the subgen directory, you can use these commands:

bash
# Create directory structure
mkdir -p subgen/src
cd subgen

# Copy files (you'll need to manually copy the content from above)
# Then make scripts executable
chmod +x setup.sh run.sh

# Run setup
./setup.sh

# Create inputs directory and add your files
mkdir -p inputs
# Copy your video/audio files to inputs/

# Run transcription
./run.sh inputs/your_video.mp4
What Each File Does
README.md: Complete documentation
requirements.txt: Python dependencies (faster-whisper, ffmpeg-python, tqdm)
setup.sh: Creates virtual environment, installs dependencies, validates setup
run.sh: Wrapper script that activates venv and runs the CLI
.gitignore: Excludes temporary files, models, inputs, outputs from git
src/init.py: Package initialization
src/cli.py: Command-line interface with argparse
src/engine.py: Core Whisper engine with VAD and glossary support
src/utils.py: Utility functions (SRT writing, audio extraction, etc.)
src/glossary.txt: Technical vocabulary for better recognition
Expected Workflow
First time setup (one time):
bash
   ./setup.sh
Downloads ~3GB model on first run
Daily usage:
bash
   # Copy video to inputs/
   cp ~/Downloads/meeting.mp4 inputs/
   
   # Generate subtitles
   ./run.sh inputs/meeting.mp4
   
   # Find output in outputs/
   # - outputs/meeting.orig.srt (original language)
   # - outputs/meeting.en.srt (English translation)
Use with VLC:
Open video in VLC
Drag and drop the .srt file onto VLC
Or: Subtitle → Add Subtitle File
All files are now complete and ready to use!f"❌ Error: Invalid input file: {input_path}", file=sys.stderr)
print(f"Supported extensions: {', '.join(get_supported_extensions())}", file=sys.stderr)
return 1

# Validate glossary if specified
glossary_path = Path(args.glossary)
if not glossary_path.exists():
    print(f"⚠️  Warning: Glossary file not found: {glossary_path}")
    print("   Proceeding without glossary...")
    glossary_path = None

# Create output directory
output_dir = Path(args.output_dir)
output_dir.mkdir(parents=True, exist_ok=True)

# Print configuration
print("=" * 60)
print("SubGen - Local Subtitle Generator")
print("=" * 60)
print(f"Input file:    {input_path}")
print(f"Mode:          {args.mode}")
print(f"Model:         {args.model_size}")
print(f"Output dir:    {output_dir}")
print(f"VAD enabled:   {not args.no_vad}")
print(f"Device:        {args.device}")
print(f"Compute type:  {args.compute_type}")
if glossary_path:
    print(f"Glossary:      {glossary_path}")
print("=" * 60)
print()

try:
    # Initialize engine
    print("Loading Whisper model...")
    print("(First run may take 10-15 minutes to download ~3GB model)")
    print()
    
    engine = SubGenEngine(
        model_size=args.model_size,
        device=args.device,
        compute_type=args.compute_type,
        enable_vad=not args.no_vad,
        glossary_path=glossary_path,
        verbose=args.verbose
    )
    
    # Process based on mode
    base_name = input_path.stem
    
    if args.mode in ["transcribe", "both"]:
        print("\n" + "=" * 60)
        print("Transcribing in original language...")
        print("=" * 60)
        orig_output = output_dir / f"{base_name}.orig.srt"
        engine.transcribe(str(input_path), str(orig_output))
        print(f"\n✓ Original language subtitles saved to: {orig_output}")
    
    if args.mode in ["translate", "both"]:
        print("\n" + "=" * 60)
        print("Translating to English...")
        print("=" * 60)
        en_output = output_dir / f"{base_name}.en.srt"
        engine.translate(str(input_path), str(en_output))
        print(f"\n✓ English subtitles saved to: {en_output}")
    
    print("\n" + "=" * 60)
    print("✅ Processing complete!")
    print("=" * 60)
    
    return 0
    
except KeyboardInterrupt:
    print("\n\n⚠️  Process interrupted by user")
    return 130

except Exception as e:
    print(f"\n❌ Error: {e}", file=sys.stderr)
    if args.verbose:
        import traceback
        traceback.print_exc()
    return 1
if name == "main": sys.exit(main())


---

## File: `src/engine.py`
```python
"""
SubGen Engine - Whisper model wrapper with VAD and glossary support
"""

from pathlib import Path
from typing import Optional, List, Dict, Any
from tqdm import tqdm

from faster_whisper import WhisperModel

from .utils import (
    write_srt,
    format_timestamp,
    load_glossary,
    remove_duplicate_segments,
    extract_audio_if_needed
)


class SubGenEngine:
    """
    Whisper-based subtitle generation engine with VAD and glossary support.
    
    Loads the model once and reuses it for multiple transcription/translation passes.
    """
    
    def __init__(
        self,
        model_size: str = "large-v3",
        device: str = "cpu",
        compute_type: str = "int8",
        enable_vad: bool = True,
        glossary_path: Optional[Path] = None,
        verbose: bool = False
    ):
        """
        Initialize the SubGen engine.
        
        Args:
            model_size: Whisper model size (tiny, base, small, medium, large-v3)
            device: Device to run on (cpu, cuda, auto)
            compute_type: Computation precision (int8, int8_float16, float16, float32)
            enable_vad: Enable voice activity detection
            glossary_path: Path to glossary file
            verbose: Enable verbose output
        """
        self.model_size = model_size
        self.device = device
        self.compute_type = compute_type
        self.enable_vad = enable_vad
        self.verbose = verbose
        
        # Load glossary if provided
        self.glossary_prompt = None
        if glossary_path:
            terms = load_glossary(glossary_path)
            if terms:
                # Create a natural language prompt with the glossary terms
                self.glossary_prompt = f"Vocabulary: {', '.join(terms)}"
                if verbose:
                    print(f"Loaded {len(terms)} terms from glossary")
        
        # VAD parameters - optimized to prevent hallucinations
        self.vad_parameters = dict(
            threshold=0.5,  # Speech probability threshold
            min_speech_duration_ms=250,  # Minimum speech segment length
            min_silence_duration_ms=500,  # Minimum silence to split segments
            speech_pad_ms=400  # Padding around speech segments
        )
        
        # Load model once - will be reused for all operations
        print(f"Loading {model_size} model with {compute_type} precision...")
        self.model = WhisperModel(
            model_size,
            device=device,
            compute_type=compute_type,
            download_root="./models",
            local_files_only=False
        )
        print("✓ Model loaded successfully")
    
    def transcribe(self, input_path: str, output_path: str) -> None:
        """
        Transcribe audio in original language(s).
        
        Args:
            input_path: Path to input audio/video file
            output_path: Path to output SRT file
        """
        # Extract audio if needed
        audio_path = extract_audio_if_needed(input_path)
        
        print(f"\nProcessing: {Path(input_path).name}")
        print(f"Task: Transcription (original language)")
        
        # Run transcription with auto language detection
        segments, info = self.model.transcribe(
            audio_path,
            task="transcribe",  # Keep original language
            language=None,  # Auto-detect
            beam_size=5,
            vad_filter=self.enable_vad,
            vad_parameters=self.vad_parameters if self.enable_vad else None,
            initial_prompt=self.glossary_prompt,
            word_timestamps=False,
            condition_on_previous_text=True
        )
        
        # Collect segments with progress bar
        print(f"Detected language: {info.language} (probability: {info.language_probability:.2f})")
        print("Transcribing...")
        
        segment_list = []
        for segment in tqdm(segments, desc="Processing segments", unit="seg"):
            segment_list.append({
                'start': segment.start,
                'end': segment.end,
                'text': segment.text.strip()
            })
        
        # Post-process to remove duplicates
        segment_list = remove_duplicate_segments(segment_list)
        
        # Write SRT file
        write_srt(segment_list, output_path)
        
        print(f"Generated {len(segment_list)} subtitle segments")
    
    def translate(self, input_path: str, output_path: str) -> None:
        """
        Translate audio to English.
        
        Args:
            input_path: Path to input audio/video file
            output_path: Path to output SRT file
        """
        # Extract audio if needed
        audio_path = extract_audio_if_needed(input_path)
        
        print(f"\nProcessing: {Path(input_path).name}")
        print(f"Task: Translation to English")
        
        # Run translation (always outputs English)
        segments, info = self.model.transcribe(
            audio_path,
            task="translate",  # Translate to English
            language=None,  # Auto-detect source language
            beam_size=5,
            vad_filter=self.enable_vad,
            vad_parameters=self.vad_parameters if self.enable_vad else None,
            initial_prompt=self.glossary_prompt,
            word_timestamps=False,
            condition_on_previous_text=True
        )
        
        # Collect segments with progress bar
        print(f"Source language: {info.language} (probability: {info.language_probability:.2f})")
        print("Translating to English...")
        
        segment_list = []
        for segment in tqdm(segments, desc="Processing segments", unit="seg"):
            segment_list.append({
                'start': segment.start,
                'end': segment.end,
                'text': segment.text.strip()
            })
        
        # Post-process to remove duplicates
        segment_list = remove_duplicate_segments(segment_list)
        
        # Write SRT file
        write_srt(segment_list, output_path)
        
        print(f"Generated {len(segment_list)} subtitle segments")
    
    def get_model_info(self) -> Dict[str, Any]:
        """Get information about the loaded model."""
        return {
            "model_size": self.model_size,
            "device": self.device,
            "compute_type": self.compute_type,
            "vad_enabled": self.enable_vad,
            "has_glossary": self.glossary_prompt is not None
        }
```

---

## File: `src/utils.py`
```python
"""
Utility functions for SubGen
"""

import tempfile
from pathlib import Path
from typing import List, Dict, Optional
import subprocess
import sys


def get_supported_extensions() -> List[str]:
    """Get list of supported file extensions."""
    return [
        # Video formats
        "mp4", "mkv", "mov", "avi", "webm", "flv", "wmv", "m4v",
        # Audio formats
        "wav", "mp3", "m4a", "aac", "flac", "ogg", "opus", "wma"
    ]


def validate_input_file(input_path: Path) -> bool:
    """
    Validate that input file exists and has supported extension.
    
    Args:
        input_path: Path to input file
        
    Returns:
        True if valid, False otherwise
    """
    if not input_path.exists():
        return False
    
    extension = input_path.suffix.lower().lstrip('.')
    return extension in get_supported_extensions()


def format_timestamp(seconds: float) -> str:
    """
    Format timestamp for SRT format (HH:MM:SS,mmm).
    
    Args:
        seconds: Time in seconds
        
    Returns:
        Formatted timestamp string
    """
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int((seconds % 1) * 1000)
    
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def write_srt(segments: List[Dict], output_path: str) -> None:
    """
    Write segments to SRT file.
    
    Args:
        segments: List of segment dictionaries with 'start', 'end', 'text'
        output_path: Output SRT file path
    """
    with open(output_path, 'w', encoding='utf-8') as f:
        for i, segment in enumerate(segments, start=1):
            # Write subtitle number
            f.write(f"{i}\n")
            
            # Write timestamp
            start_time = format_timestamp(segment['start'])
            end_time = format_timestamp(segment['end'])
            f.write(f"{start_time} --> {end_time}\n")
            
            # Write text
            f.write(f"{segment['text']}\n")
            
            # Blank line between subtitles
            f.write("\n")


def load_glossary(glossary_path: Path) -> List[str]:
    """
    Load glossary terms from file.
    
    Args:
        glossary_path: Path to glossary file
        
    Returns:
        List of glossary terms
    """
    if not glossary_path.exists():
        return []
    
    terms = []
    try:
        with open(glossary_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                # Skip empty lines and comments
                if line and not line.startswith('#'):
                    terms.append(line)
    except Exception as e:
        print(f"Warning: Could not load glossary: {e}", file=sys.stderr)
        return []
    
    return terms


def remove_duplicate_segments(segments: List[Dict]) -> List[Dict]:
    """
    Remove duplicate consecutive segments (hallucination artifact).
    
    Args:
        segments: List of segment dictionaries
        
    Returns:
        Filtered list of segments
    """
    if not segments:
        return segments
    
    filtered = [segments[0]]
    
    for segment in segments[1:]:
        prev_segment = filtered[-1]
        
        # Check if current segment is a duplicate of the previous one
        # (same text and very close timestamps)
        if segment['text'] == prev_segment['text']:
            time_diff = abs(segment['start'] - prev_segment['start'])
            # If timestamps are very close (< 2 seconds), it's likely a duplicate
            if time_diff < 2.0:
                continue
        
        filtered.append(segment)
    
    return filtered


def extract_audio_if_needed(input_path: str) -> str:
    """
    Extract audio from video file if needed using ffmpeg.
    
    Args:
        input_path: Path to input file
        
    Returns:
        Path to audio file (original if already audio, extracted if video)
    """
    input_path_obj = Path(input_path)
    extension = input_path_obj.suffix.lower().lstrip('.')
    
    # Audio formats that don't need extraction
    audio_formats = ["wav", "mp3", "m4a", "aac", "flac", "ogg", "opus"]
    
    if extension in audio_formats:
        return input_path
    
    # Video file - extract audio
    print(f"Extracting audio from video file...")
    
    # Create temporary file for extracted audio
    temp_audio = tempfile.NamedTemporaryFile(
        suffix=".wav",
        delete=False,
        dir=Path(input_path).parent
    )
    temp_audio_path = temp_audio.name
    temp_audio.close()
    
    try:
        # Use ffmpeg to extract audio
        # -vn: no video
        # -acodec pcm_s16le: 16-bit PCM
        # -ar 16000: 16kHz sample rate (Whisper's native rate)
        # -ac 1: mono audio
        cmd = [
            "ffmpeg",
            "-i", input_path,
            "-vn",  # No video
            "-acodec", "pcm_s16le",  # 16-bit PCM
            "-ar", "16000",  # 16kHz
            "-ac", "1",  # Mono
            "-y",  # Overwrite output
            temp_audio_path
        ]
        
        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg failed: {result.stderr}")
        
        print(
