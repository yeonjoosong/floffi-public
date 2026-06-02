import { createPortal } from "react-dom";
import { PlaygroundModal } from "./PlaygroundModal";
import { TrashModal } from "./TrashModal";
import { UserInfoModal } from "./UserInfoModal";
import type { Section, Task } from "../lib/types";
import type { TouchDragState } from "../lib/touchDnd";

type BoardViewOverlaysProps = {
  playgroundOpen: boolean;
  trashOpen: boolean;
  userInfoOpen: boolean;
  username: string;
  nickname: string;
  sessionEmail: string;
  avatar: string;
  tasks: Task[];
  sections: Section[];
  trashedTasks: Task[];
  touchDragState: TouchDragState;
  onClosePlayground: () => void;
  onCloseTrash: () => void;
  onCloseUserInfo: () => void;
  onRestoreDeletedTask: (taskId: string) => void;
  onPurgeDeletedTask: (taskId: string) => void;
  onNicknameSaved: () => void;
};

export function BoardViewOverlays(props: BoardViewOverlaysProps) {
  return (
    <>
      {props.playgroundOpen && <PlaygroundModal onClose={props.onClosePlayground} />}
      {props.trashOpen ? (
        <TrashModal
          tasks={props.trashedTasks}
          onRestore={props.onRestoreDeletedTask}
          onPurge={props.onPurgeDeletedTask}
          onClose={props.onCloseTrash}
        />
      ) : null}
      {props.userInfoOpen ? (
        <UserInfoModal
          username={props.username}
          nickname={props.nickname}
          email={props.sessionEmail}
          avatar={props.avatar}
          onSaved={props.onNicknameSaved}
          onClose={props.onCloseUserInfo}
        />
      ) : null}
      {props.touchDragState.draggingId && props.touchDragState.position
        ? createPortal(
            <div
              data-touch-ghost="1"
              style={{
                position: "fixed",
                left: props.touchDragState.position.x,
                top: props.touchDragState.position.y - 36,
                transform: "translate(-50%, -50%)",
                pointerEvents: "none",
                zIndex: 90,
              }}
              className="rounded-xl border border-ac/50 bg-s1/95 px-3 py-2 text-xs font-bold text-t1 shadow-2xl backdrop-blur-sm"
            >
              {props.touchDragState.kind === "task"
                ? props.tasks.find((task) => task.id === props.touchDragState.draggingId)?.title ?? "태스크"
                : props.sections.find((section) => section.id === props.touchDragState.draggingId)?.title ?? "섹션"}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
