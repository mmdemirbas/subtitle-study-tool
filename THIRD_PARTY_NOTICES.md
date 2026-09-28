# Third-party notices

The code in this repository is MIT (see `LICENSE`). Three generated data files
are derived from sources under the Creative Commons Attribution-ShareAlike 4.0
International license, and those files are distributed under the same license:
<https://creativecommons.org/licenses/by-sa/4.0/>.

| File | Derived from | Changes |
|---|---|---|
| `browser-extension/src/study/frequency-en.generated.txt` | [FrequencyWords](https://github.com/hermitdave/FrequencyWords) by Hermit Dave, English list, counted over the OpenSubtitles corpus | The 2018 50k list, lowercased, letters only, words seen fewer than 12 times dropped, cut to the first 30,000; counts dropped, rank is the line number. Built by `browser-extension/tools/build-frequency.mjs` |
| `browser-extension/src/study/frequency-tr.generated.txt` | The same project's Turkish list | As above |
| `browser-extension/src/study/phrases-en.generated.txt` | The member titles of Wiktionary's [Category:English phrasal verbs](https://en.wiktionary.org/wiki/Category:English_phrasal_verbs) | Filtered and reordered by how often each phrase occurs in a local subtitle cache. Built by `browser-extension/tools/build-phrases.mjs` |

FrequencyWords is MIT for its code and CC BY-SA 4.0 for its content (its
README, "License"). Wiktionary text is CC BY-SA 4.0
(<https://en.wiktionary.org/wiki/Wiktionary:Copyrights>).
