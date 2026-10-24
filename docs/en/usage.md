# Working with a team

[First project](getting-started.md) · [Architecture](architecture.md) · [中文](../zh-CN/usage.md)

## Discuss and delegate

The Host is your ongoing conversation with a team. Describe the intended result, relevant files and acceptance criteria. Continue discussing the project while members execute. The Host can create or reuse members and select execution resources according to the available catalog.

## Follow a work thread

A work thread groups an assigned responsibility, its execution attempts, messages and deliveries. Open the member or work details to inspect activity. A read-only follow-up asks about existing work; **Continue modifying** requests another change and allows a new delivery.

Members can ask one another questions and exchange information during execution. The collaboration view displays the corresponding recorded activity. An unanswered request or unresolved commitment remains part of the team's state.

## Check a delivery

Open the delivered artifact, inspect its exact version and download it when needed. A follow-up delivery creates a new version while retaining the original. Ask for concrete checks appropriate to the task, such as the command and output in the getting-started example.

Small reversible work can use self-check delivery. When independent acceptance is required, specify a separate reviewer and the checks it must perform against the submitted version. The product records the review and acceptance for that version.

## Change direction

Describe changed requirements in the Host conversation. Current project definitions and work retain revision information, so an affected task can be updated or rerun against the intended definition. In project history, inspect the relevant node before creating a new branch from saved files. Keep external services and project files backed up separately when they are outside the recorded local snapshot.

## Pause, resume and recover

Use the execution controls to pause or stop work. Wait for the displayed execution state to settle before starting conflicting changes. If the service loses contact with an attempt, use recovery to reconcile it before retrying. See [Troubleshooting](troubleshooting.md).

## File ownership and continuation

Each production task declares the relative files or directories it owns. Members use Team file tools for those changes; other project files remain read-only. A write requires the current file hash, and overlapping active ownership is rejected. Disjoint file tasks can run concurrently. Repeating the same responsibility returns its existing work; send new instructions to that thread or continue it explicitly.

Continue a work thread to retain its member, file scope and unpublished candidate. The earlier result and the new submission keep separate versions.

## Update an independent review

Change review instructions on the existing review. A running reviewer must read the new revision before accepting work and rerun required commands afterward. File-only reviews can compare content without a command sandbox. Executable checks require a member with native check support; TeamSwarm prepares a temporary directory while keeping project files read-only.

## Adopt a discussion branch

Discuss an idea in its source branch and keep it as a proposed insight. When you decide to adopt it, tell the Host directly, for example: “Adopt this branch's proposed reading layout into the mainline documents.” The Host compares the source, its base and the current mainline, then updates the selected documents. A newer message or a changed branch head requires it to read the current decision and context again.

Open the merge node in project history to see the decision, source discussion, selected ideas and document changes. Adoption updates project definitions; request implementation when you want those definitions applied to code.

## Progress and completed results

Progress updates and completed deliverables have separate lists. A completed result remains available when a full workspace snapshot cannot be captured. History nodes without a file snapshot can be inspected; creating a new workspace branch requires a node with a saved snapshot.
