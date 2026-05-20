import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

class RootErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  // 흰 화면 사망의 원인을 콘솔에 남긴다. 폴백만 띄우면 사용자는 멈췄는지
  // 알아도 우리는 무엇이 터졌는지 알 수 없어 진단이 불가능하다.
  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error("RootErrorBoundary caught:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="flex min-h-screen items-center justify-center bg-chick-50 px-6 text-center text-ink-900">
          <div className="max-w-xl rounded-[2rem] bg-white p-8 shadow-card">
            <h1 className="text-3xl">화면을 불러오는 중 문제가 발생했습니다.</h1>
            <p className="mt-4 leading-8 text-ink-700">
              아래 버튼으로 다시 시도해 보세요. 계속 같은 문제가 나면 최신 브라우저에서 다시 접속해 주세요.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-6 rounded-full bg-ink-900 px-6 py-3 text-white transition hover:bg-ink-700"
            >
              새로고침
            </button>
          </div>
        </main>
      );
    }

    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>,
);
