#!/usr/bin/env python
import sys
# import pprint
import time
from googletrans import Translator, LANGUAGES
from google.cloud import translate_v2 as translate
import diskcache

polis_languages = [
    "Chinese (traditional)",
    "Chinese (simplified)",
    "Danish",
    "German",
    "Spanish",
    "Persian", # Farsi
    "French",
    "Italian",
    "Dutch",
    "Portuguese",
    "Japanese",
    "Croatian",
    "Slovak",
    "Hebrew",
    "Welsh",
    "Greek",
    "Ukrainian",
    "Russian",
    ]

LANGUAGE_KEY_LOOKUP = {}
for key, value in LANGUAGES.items():
    LANGUAGE_KEY_LOOKUP[value] = key

CACHE_DIR = './translations_cache'

# Create or get an existing cache
cache = diskcache.Cache(CACHE_DIR)

client = translate.Client()

def translate_text(text, target_language):
    return client.translate(text, target_language=target_language)["translatedText"]

def translate_to_multiple_languages(phrase, languages=[]):
    # translator = Translator()

    selected_languages = []
    for polis_language in polis_languages:
        selected_languages.append(LANGUAGE_KEY_LOOKUP[polis_language.lower()])

    translations = {}

    for lang in selected_languages:
        # Check cache first
        cache_key = f"{phrase}_{lang}"
        if cache_key in cache:
            translations[LANGUAGES[lang]] = cache[cache_key]
        else:
            # If not in cache, fetch translation
            try:
                translated_text = translate_text(phrase, lang)
                translations[LANGUAGES[lang]] = translated_text
                # Store in cache
                cache[cache_key] = translated_text
            except Exception as e:
                print(f"Error translating into {LANGUAGES[lang]}: {e}")
        print(f'{cache_key}: {translations[LANGUAGES[lang]]}')
    return translations

if __name__ == "__main__":
    if len(sys.argv) > 1:
        phrase = sys.argv[1]
        translations = translate_to_multiple_languages(phrase)

        for lang, translated_text in translations.items():
            print(f"{lang}({LANGUAGE_KEY_LOOKUP[lang]}): {translated_text}")
        print(f"Translated into {len(translations)} languages.")

        # Remember to close the cache when done to free up resources
        cache.close()
    else:
        print("Please provide a phrase to translate. Usage: python script_name.py 'Your phrase'")

