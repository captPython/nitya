import type { TopicContent } from "../../types";
import { COUNTING } from "./counting";
import { BEFORE_AFTER } from "./before-after";
import { COMPARING } from "./comparing";
import { ADDITION } from "./addition";
import { SUBTRACTION } from "./subtraction";

/** UKG Phase 1 topics, in the order they unlock. */
export const UKG_TOPICS: TopicContent[] = [COUNTING, BEFORE_AFTER, COMPARING, ADDITION, SUBTRACTION];
