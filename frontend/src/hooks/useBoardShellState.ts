import { useCallback, useEffect, useRef, useState } from "react";
import { useEscapeClose } from "../lib/escapeStack";

export type LeftTab = "teams" | "agents";
export type RightTab = "inbox" | "settings" | "vault" | "history";
export type SettingsSubTab = "general" | "workspace" | "security" | "memory" | "ai" | "notifications";
type InboxTimeRange = "1h" | "2h" | "business" | "today" | "3d" | "7d" | "all";
type InboxStatusFilter = "all" | "new" | "approved" | "rejected";

export interface InboxFilter {
  timeRange: InboxTimeRange;
  maxCount: number;
  status: InboxStatusFilter;
}

const INBOX_FILTER_KEY = "floffi-inbox-filter";

function loadInboxFilter(): InboxFilter {
  try {
    const raw = localStorage.getItem(INBOX_FILTER_KEY);
    if (raw) return JSON.parse(raw) as InboxFilter;
  } catch {}
  return { timeRange: "all", maxCount: 0, status: "all" };
}

export function useBoardShellState() {
  const [leftTab, setLeftTab] = useState<LeftTab>("teams");
  const [rightTab, setRightTab] = useState<RightTab>("inbox");
  const [settingsSubTab, setSettingsSubTab] = useState<SettingsSubTab>("general");
  const [assignOpen, setAssignOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return !window.matchMedia("(max-width: 767px)").matches;
  });
  const [inboxFilter, setInboxFilter] = useState<InboxFilter>(loadInboxFilter);
  const [inboxFilterOpen, setInboxFilterOpen] = useState(false);
  const [leftDrawerOpen, setLeftDrawerOpen] = useState(false);
  const [rightDrawerOpen, setRightDrawerOpen] = useState(false);
  const [statusPanelOpen, setStatusPanelOpen] = useState(false);
  const [userInfoOpen, setUserInfoOpen] = useState(false);
  const [clearInboxOpen, setClearInboxOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [playgroundOpen, setPlaygroundOpen] = useState(false);

  const leftDrawerScrollRef = useRef<HTMLDivElement | null>(null);
  const rightDrawerScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (leftDrawerOpen && leftDrawerScrollRef.current) leftDrawerScrollRef.current.scrollTop = 0;
  }, [leftDrawerOpen]);

  useEffect(() => {
    if (rightDrawerOpen && rightDrawerScrollRef.current) rightDrawerScrollRef.current.scrollTop = 0;
  }, [rightDrawerOpen]);

  const openRightDrawer = useCallback(() => {
    setLeftDrawerOpen(false);
    setRightDrawerOpen(true);
  }, []);

  const toggleLeftDrawer = useCallback(() => {
    setLeftDrawerOpen((value) => {
      const next = !value;
      if (next) setRightDrawerOpen(false);
      return next;
    });
  }, []);

  const toggleRightDrawer = useCallback(() => {
    setRightDrawerOpen((value) => {
      const next = !value;
      if (next) setLeftDrawerOpen(false);
      return next;
    });
  }, []);

  const closeDrawers = useCallback(() => {
    setLeftDrawerOpen(false);
    setRightDrawerOpen(false);
  }, []);
  useEscapeClose(leftDrawerOpen || rightDrawerOpen, closeDrawers);

  const closeStatusPanel = useCallback(() => setStatusPanelOpen(false), []);
  useEscapeClose(statusPanelOpen, closeStatusPanel);

  useEffect(() => {
    if (!statusPanelOpen) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('[data-role="status-panel"]')) return;
      if (target.closest('[data-role="status-panel-trigger"]')) return;
      setStatusPanelOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [statusPanelOpen]);

  useEffect(() => {
    try { localStorage.setItem(INBOX_FILTER_KEY, JSON.stringify(inboxFilter)); } catch {}
  }, [inboxFilter]);

  return {
    leftTab,
    setLeftTab,
    rightTab,
    setRightTab,
    settingsSubTab,
    setSettingsSubTab,
    assignOpen,
    setAssignOpen,
    inboxFilter,
    setInboxFilter,
    inboxFilterOpen,
    setInboxFilterOpen,
    leftDrawerOpen,
    setLeftDrawerOpen,
    rightDrawerOpen,
    setRightDrawerOpen,
    statusPanelOpen,
    setStatusPanelOpen,
    userInfoOpen,
    setUserInfoOpen,
    clearInboxOpen,
    setClearInboxOpen,
    trashOpen,
    setTrashOpen,
    playgroundOpen,
    setPlaygroundOpen,
    leftDrawerScrollRef,
    rightDrawerScrollRef,
    openRightDrawer,
    toggleLeftDrawer,
    toggleRightDrawer,
    closeDrawers,
  };
}
