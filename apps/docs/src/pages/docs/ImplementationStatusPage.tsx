import DocPage from "../../components/docs/DocPage";
import markdown from "../../../../../docs/IMPLEMENTATION_STATUS.md?raw";

export default function ImplementationStatusPage() {
  return <DocPage markdown={markdown} />;
}
