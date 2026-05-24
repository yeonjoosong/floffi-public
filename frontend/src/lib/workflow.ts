import type { AgentMember, Section, WorkflowStep } from "./types";

export const WORKFLOW_SECTIONS: Section[] = [
  { id: "wf-planning", title: "Planning" },
  { id: "wf-building", title: "Building" },
  { id: "wf-executing", title: "Executing" },
  { id: "wf-analysis", title: "Analysis" },
  { id: "wf-review", title: "Review" },
];

const WORKFLOW_AGENT_TEMPLATES: Array<Pick<AgentMember, "id" | "name" | "role">> = [
  { id: "planner", name: "Planner", role: "Breaks tasks into steps and creates a plan" },
  { id: "builder", name: "Builder", role: "Implements and verifies changes" },
  { id: "executor", name: "Executor", role: "Executes the plan and collects data" },
  { id: "analyst", name: "Analyst", role: "Analyzes data and produces statistics" },
  { id: "summarizer", name: "Summarizer", role: "Summarizes findings and writes final report" },
];

export function makeWorkflowAgents(teamId: string): AgentMember[] {
  return WORKFLOW_AGENT_TEMPLATES.map((agent) => ({ ...agent, teamId, status: "idle" as const }));
}

export const DEFAULT_WORKFLOW_STEPS: WorkflowStep[] = [
  { agentId: "planner", sectionId: "wf-planning", label: "Plan" },
  { agentId: "builder", sectionId: "wf-building", label: "Build" },
  { agentId: "executor", sectionId: "wf-executing", label: "Execute" },
  { agentId: "analyst", sectionId: "wf-analysis", label: "Analyze" },
  { agentId: "summarizer", sectionId: "wf-review", label: "Summarize" },
];
