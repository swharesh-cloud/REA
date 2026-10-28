"use client";

import { useParams } from "next/navigation";

import { LectureDetail } from "../../../components/lecture-detail";

export default function LecturePage() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === "string" ? params.id : "";
  return <LectureDetail id={id} />;
}
