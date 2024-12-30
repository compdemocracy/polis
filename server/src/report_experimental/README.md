# Report Experimental

This is an experimental library for generating reports from Polis conversations.

These reports are to be checked by a human editor for hallucinations, before being published to participants. A user interface will be provided to the editor to help with this process, and this system is designed to support this process.

This library is model agnostic, and evals will cover both open source and proprietary models.

## Structure

The structure of the library is as follows:

Rough explanation of the intended structure (general schema, not all files):

📁 server/src/report_experimental/
├── readme.md # This documentation file
├── system.xml # Main system prompt, specificying the role of the LLM agent
└── 📁 subtaskPrompts/ # Folder containing subtask prompts
....├── uncertainty.xml # Handling uncertainty in reports
....└── 📁 common/ # Common subtask components
└── 📁 languageModels/ # Adapters for different language models

## Approach

This experimental library is designed to be a modular system for generating reports from Polis conversations.

The system prompt is designed to be a general prompt that can be used for any language model.

The subtask prompts are designed to be specific to the task of generating a report, and are designed to be used with a language model that is able to handle the subtask.
