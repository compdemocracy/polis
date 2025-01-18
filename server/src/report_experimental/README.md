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

## Checking Your Report during development as a human evaluator

### Purpose

The report generation system is designed to create accurate, evidence-based narratives from Pol.is conversations that fairly represent all participant viewpoints, maintain precision without sacrificing accessibility, support every claim with proper citations, avoid interpretation beyond what the data shows, and present patterns rather than individual statements. When reviewing a generated report, focus on avoiding common LLM pitfalls like hallucinations or misrepresentation.

### 1. Citation Integrity

- Each clause should have 1-5 supporting citations
- Citations should directly support the claims made
- Check for over-citation (using multiple citations when one would suffice)
- Verify citations aren't being used out of context

### 2. Statement Accuracy

- **Descriptive Statements**: When the report describes what "participants discussed", verify the topics exist in the source material
- **Stance Attribution**: When the report claims participants "emphasized" or "agreed", verify both:
  - The content matches what participants actually said
  - The voting patterns support the claimed stance
- **Flag Complete Fabrications**: Identify any statements about things not present in the source material
- **Check for Misrepresentation**: Look for subtle inaccuracies in how statements are characterized

### 3. Voting Pattern Verification

- When "consensus" is claimed, verify agreement across all groups
- For "broad agreement" claims, check if true group-informed consensus exists
- Verify any claimed differences between groups match actual voting patterns
- Watch for cases where disagreement is reported but voting shows agreement (or vice versa)

### 4. Group Dynamic Accuracy

- For group-specific claims (e.g., "Group A showed higher agreement"), verify:
  - The actual voting patterns within that group
  - The comparison to other groups is accurate
- Check that group characterizations are supported by multiple data points
- Ensure minority viewpoints aren't misrepresented when discussing consensus

### 5. Narrative Flow & Truthfulness

- Does the report read like a natural story while staying true to the data?
- Are we jumping between topics in a way that makes sense, or does it feel forced?
- When we group comments into themes, are we being consistent or getting sloppy?
- If we say "participants generally felt X", can we back that up with multiple comments/votes?
- Are we drawing conclusions that actually match what people said and how they voted?
- Are we implying X caused Y without solid evidence?

### Common Red Flags

- Statements without citations
- Overly broad generalizations from limited data
- Single citations used to support multiple unrelated claims
- Unsupported claims about group differences
- Mischaracterized voting patterns
- Solutions or recommendations not present in data
