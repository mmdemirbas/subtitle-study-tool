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

Note: `large-v3-turbo` is significantly faster (~8x) but not yet available in CTranslate2 format. We prioritize accuracy over speed.

## Project Structure

```
subgen/
├── inputs/          # Place your video/audio files here (not tracked)
├── outputs/         # Generated subtitle files (not tracked)
├── models/          # Cached Whisper models (not tracked)
├── src/
│   ├── __init__.py
│   ├── cli.py       # Command-line interface
│   ├── engine.py    # Whisper model wrapper with VAD
│   ├── utils.py     # SRT formatting and file utilities
│   └── glossary.txt # Default technical vocabulary
├── requirements.txt
├── setup.sh         # One-time setup script
├── run.sh          # Convenience wrapper for CLI
├── .gitignore
└── README.md
```

## Advanced Configuration

### Adjusting Model Settings

You can modify `src/engine.py` to tune performance:

```python
# Trade accuracy for speed
model = WhisperModel(
    model_size,
    device="cpu",
    compute_type="int8",
    cpu_threads=4,  # Reduce for lower CPU usage
    num_workers=1
)

# Adjust VAD sensitivity
vad_parameters = dict(
    threshold=0.5,              # Lower = more sensitive
    min_speech_duration_ms=250, # Minimum speech length
    min_silence_duration_ms=500 # Silence before split
)
```

### Model Size Options

| Model | Parameters | Accuracy | Speed | VRAM (int8) |
|-------|-----------|----------|-------|-------------|
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
4. For mixed-language content, use `--mode transcribe` to preserve original languages

### Slow Performance

- Large-v3 on M1 is CPU-intensive; this is expected
- Close background applications
- Ensure laptop is plugged in (performance mode)
- Consider using `medium` or `distil-large-v3` for faster processing

## Privacy & Security

- **Zero Data Transmission**: All processing happens locally
- **No Telemetry**: No usage statistics collected
- **No API Keys**: No third-party services required
- **Internet Usage**: Only for downloading models during setup

## Future Enhancements

Potential additions (not yet implemented):

- **Speaker Diarization**: Label speakers as "Speaker 1", "Speaker 2" etc.
- **Batch Processing**: Process entire folders automatically
- **GPU Acceleration**: Metal Performance Shaders support
- **Word-Level Timestamps**: More granular subtitle timing
- **WebVTT Output**: Alternative subtitle format
- **Live Transcription**: Real-time microphone input

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

### VAD Implementation

Uses Silero VAD integrated in faster-whisper to:
- Detect speech segments
- Skip silent portions
- Prevent repetitive hallucinations
- Improve timestamp accuracy

## Contributing

This is a single-user tool designed for personal use. Feel free to fork and modify for your needs.

## License

This project uses:
- faster-whisper (MIT License)
- OpenAI Whisper models (MIT License)
- Silero VAD (MIT License)

## Credits

Built with:
- [faster-whisper](https://github.com/SYSTRAN/faster-whisper) by Systran
- [OpenAI Whisper](https://github.com/openai/whisper)
- [CTranslate2](https://github.com/OpenNMT/CTranslate2)

---

**Support**: For issues, check Troubleshooting section or review the code in `src/` directory.