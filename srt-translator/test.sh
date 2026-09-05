#!/usr/bin/env bash

# Beside the viewer, in this repo. The path this used to hold was the one the
# file had before the subtitle tools were gathered here, so the script asked to
# spend money on a file that had not existed for some time.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
file="$here/../srt-viewer/subtitles/Battlestar.Galactica.Miniseries.S00E02.2003.1080p.BluRay-EN.srt"

source .venv/bin/activate # activate virtual environment
source .env               # load OPENAI_API_KEY, which srt_translate.py reads
                          # from the environment - passing it as an argument
                          # instead would put the key in every ps listing

# Ask before starting to avoid accidental API costs
read -p "This will invoke paid OpenAI APIs to translate the file $file. Do you want to continue? (y/N) " choice
if [[ "$choice" != "y" ]]; then
  echo "Aborting."
  exit 1
fi

python srt_translate.py "$file" \
  --provider openai \
  --openai-model gpt-5-nano \
  --tgt tr \
  --batch 20
