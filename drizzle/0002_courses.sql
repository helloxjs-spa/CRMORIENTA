CREATE TABLE "course_costs" (
	"course_id" uuid PRIMARY KEY NOT NULL,
	"cost_cents" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "course_costs_non_negative" CHECK ("course_costs"."cost_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "courses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "course_costs" ADD CONSTRAINT "course_costs_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_costs" ADD CONSTRAINT "course_costs_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "courses_name_unique" ON "courses" USING btree (lower("name"));--> statement-breakpoint
-- Cursos podem estar em leads/vendas históricos: nunca são apagados (usa-se active).
CREATE OR REPLACE FUNCTION forbid_course_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% não permite exclusão física; desative o curso', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER courses_no_delete BEFORE DELETE ON courses
  FOR EACH ROW EXECUTE FUNCTION forbid_course_delete();
--> statement-breakpoint
CREATE TRIGGER course_costs_no_delete BEFORE DELETE ON course_costs
  FOR EACH ROW EXECUTE FUNCTION forbid_course_delete();
