{{/*
The chart name, or nameOverride.
*/}}
{{- define "podiumd-admin.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
The full name of the resources: fullnameOverride, or "<release>-<name>", or the
release name when it already contains the name.
*/}}
{{- define "podiumd-admin.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
The name of the migration hook Job.
*/}}
{{- define "podiumd-admin.migrationsName" -}}
{{- printf "%s-migrations" (include "podiumd-admin.fullname" . | trunc 52 | trimSuffix "-") }}
{{- end }}

{{- define "podiumd-admin.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "podiumd-admin.selectorLabels" -}}
app.kubernetes.io/name: {{ include "podiumd-admin.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "podiumd-admin.labels" -}}
helm.sh/chart: {{ include "podiumd-admin.chart" . }}
{{ include "podiumd-admin.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: podiumd
{{- end }}

{{/*
The ServiceAccount of the Admin Tool pod.
*/}}
{{- define "podiumd-admin.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "podiumd-admin.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
The image: "<registry>/<repository>:<tag>". global.imageRegistry replaces
image.registry; an empty tag is the chart's appVersion. A tag may carry a
digest ("<tag>@sha256:<digest>"), as PodiumD pins its images.
*/}}
{{- define "podiumd-admin.image" -}}
{{- $registry := default .Values.image.registry ((.Values.global).imageRegistry) }}
{{- $tag := default .Chart.AppVersion .Values.image.tag }}
{{- if $registry }}
{{- printf "%s/%s:%s" $registry .Values.image.repository $tag }}
{{- else }}
{{- printf "%s:%s" .Values.image.repository $tag }}
{{- end }}
{{- end }}

{{/*
The host of settings.publicHostname without its port, for the Ingress and the
HTTPRoute, which take a bare hostname.
*/}}
{{- define "podiumd-admin.host" -}}
{{- regexReplaceAll ":[0-9]+$" .Values.settings.publicHostname "" }}
{{- end }}

{{/*
The container security context (ADR 0007). values.schema.json already refuses
values that weaken it; the hardened fields are set here as well, so they hold
even when an installer skips schema validation.
*/}}
{{- define "podiumd-admin.securityContext" -}}
{{- $context := deepCopy (default (dict) .Values.securityContext) }}
{{- $_ := set $context "runAsNonRoot" true }}
{{- $_ = set $context "readOnlyRootFilesystem" true }}
{{- $_ = set $context "allowPrivilegeEscalation" false }}
{{- $_ = set $context "privileged" false }}
{{- $_ = set $context "capabilities" (dict "drop" (list "ALL")) }}
{{- toYaml $context }}
{{- end }}

{{/*
The pod security context (ADR 0007): runAsNonRoot is always true.
*/}}
{{- define "podiumd-admin.podSecurityContext" -}}
{{- $context := deepCopy (default (dict) .Values.podSecurityContext) }}
{{- $_ := set $context "runAsNonRoot" true }}
{{- toYaml $context }}
{{- end }}

{{/*
The pod settings the Admin Tool pod and the migration Job share.
*/}}
{{- define "podiumd-admin.podScheduling" -}}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}
