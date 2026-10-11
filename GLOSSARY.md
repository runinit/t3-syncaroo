# Conversation importing

Language for bringing local provider conversations into T3 Code and keeping them
usable over time.

## Language

**Source session**:
The original Codex or Claude Code conversation from which history is imported.

**Imported task**:
A T3 task created from a source session or one of its conversation branches.

**Synchronization**:
Adding newly settled source turns to an imported task whose existing history still
matches, including recognizing matching turns already continued through T3.

**Replacement**:
Creating a complete new imported task that takes over the previous task's
synchronization identity and eligible session continuation, while retiring the old task.

**Session continuation**:
Sending another turn through T3 using the imported task's original source session.
