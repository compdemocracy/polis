# Report Experimental

This is an experimental library for generating reports from Polis conversations.

These reports are to be checked by a human editor for hallucinations, before being published to participants. A user interface will be provided to the editor to help with this process, and this system is designed to support this process.

This library is model agnostic, and evals will cover both open source and proprietary models.

## Structure

The structure of the library is as follows:

Rough explanation of the intended structure (general schema, not all files):

📁 server/src/prompts/report_experimental/
├── readme.md # This documentation file
├── system.xml # Main system prompt, specificying the role of the LLM agent
└── 📁 subtasks/ # Folder containing subtask prompts
....├── uncertainty.xml # Handling uncertainty in reports
....└── 📁 common/ # Common subtask components
........└── jsonSchema.xml # Shared JSON schema definitions
........└── typesReference.xml # Reference implementations of typescript types
└── 📁 evals/ # Evals notebooks
└── 📁 scripts/ # Run everything locally for R&D

## Approach

This experimental library
