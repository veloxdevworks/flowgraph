import { Outlet } from "react-router-dom";
import DocsSidebar from "../components/DocsSidebar";

export default function DocsLayout() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10 lg:flex-row lg:gap-10">
      <DocsSidebar />
      <div className="min-w-0 flex-1">
        <div className="max-w-3xl">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
