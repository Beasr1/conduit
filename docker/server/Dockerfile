# syntax=docker/dockerfile:1
# Build context is the repo root: docker build -f docker/server/Dockerfile .

# Keep this version equal to server/go.mod's toolchain line. Official Go images
# set GOTOOLCHAIN=local, so a newer requirement fails the build.
FROM golang:1.27.2-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS build
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/conduit ./cmd/conduit

# distroless/static ships CA certificates, which outbound HTTPS needs.
FROM gcr.io/distroless/static-debian13:nonroot@sha256:18f4cc26c9ffa7f20a359298be7deadac5c607c8e03a02b8119f1a5fc2f82c99
COPY --from=build /out/conduit /conduit
# Inside the container it must listen on all interfaces; compose decides
# what reaches it.
ENV CONDUIT_HTTP_ADDR=:8080
EXPOSE 8080
ENTRYPOINT ["/conduit"]
