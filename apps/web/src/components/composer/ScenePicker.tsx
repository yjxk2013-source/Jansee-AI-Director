type CreationScene = "online-ecommerce" | "physical-store" | "personal-creation" | "quick-cut";

interface ScenePickerProps {
  creationScene: CreationScene;
  setCreationScene: (scene: CreationScene) => void;
  guestTip: string;
  isGuestViewer: boolean;
  guideGuestToRegister: (feature: string) => void;
  onSceneChange: () => void;
}

export function ScenePicker({
  creationScene,
  setCreationScene,
  guestTip,
  isGuestViewer,
  guideGuestToRegister,
  onSceneChange,
}: ScenePickerProps) {
  return (
    <div className="creation-scene-picker" role="group" aria-label="选择创作场景">
      {guestTip && (
        <div className="guest-tip" role="status">
          {guestTip}
        </div>
      )}
      <div className="creation-scene-options">
        <button
          type="button"
          className={`${creationScene === "online-ecommerce" ? "is-selected" : ""}${isGuestViewer ? " is-locked" : ""}`}
          aria-pressed={creationScene === "online-ecommerce"}
          title={isGuestViewer ? "注册登录后可使用" : undefined}
          onClick={() => {
            if (isGuestViewer) {
              guideGuestToRegister("带货视频");
              return;
            }
            setCreationScene("online-ecommerce");
            onSceneChange();
          }}
        >
          带货视频
        </button>
        <button
          type="button"
          className={`${creationScene === "physical-store" ? "is-selected" : ""}${isGuestViewer ? " is-locked" : ""}`}
          aria-pressed={creationScene === "physical-store"}
          title={isGuestViewer ? "注册登录后可使用" : undefined}
          onClick={() => {
            if (isGuestViewer) {
              guideGuestToRegister("门店获客");
              return;
            }
            setCreationScene("physical-store");
            onSceneChange();
          }}
        >
          门店获客
        </button>
        <button
          type="button"
          className={creationScene === "personal-creation" ? "is-selected" : ""}
          aria-pressed={creationScene === "personal-creation"}
          onClick={() => {
            setCreationScene("personal-creation");
            onSceneChange();
          }}
        >
          个人创作 <span className="creation-scene-free-label" title="免费" aria-label="免费">免</span>
        </button>
        <button
          type="button"
          className={creationScene === "quick-cut" ? "is-selected" : ""}
          aria-pressed={creationScene === "quick-cut"}
          onClick={() => {
            setCreationScene("quick-cut");
            onSceneChange();
          }}
        >
          一句话剪辑 <span className="creation-scene-free-label" title="免费" aria-label="免费">免</span>
        </button>
      </div>
    </div>
  );
}

