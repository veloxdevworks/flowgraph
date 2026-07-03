import DocPage from "../../components/docs/DocPage";
import markdown from "../../../../../docs/13-getting-started.md?raw";

export default function GettingStartedPage() {
  return <DocPage markdown={markdown} />;
}
