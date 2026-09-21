/* ADR77 H0 experiment only. Not a production host, lock protocol or auth server.
 * Never unlink the lock inode: removing an actively used lock can create two owners.
 */
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv) {
  if (argc < 3) return 64;
  umask(0077);
  if (strcmp(argv[1], "lock") == 0) {
    int fd = open(argv[2], O_RDWR | O_CREAT | O_NOFOLLOW, 0600);
    if (fd < 0) { perror("open"); return 1; }
    struct stat st;
    if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_uid != getuid()) return 1;
    if (flock(fd, LOCK_EX | LOCK_NB)) {
      int busy = errno == EWOULDBLOCK || errno == EAGAIN;
      close(fd);
      return busy ? 73 : 1;
    }
    puts("LOCKED"); fflush(stdout);
    (void)getchar(); /* stdin EOF is controlled normal release */
    close(fd);
    return 0;
  }
  if (strcmp(argv[1], "peer") == 0 && argc == 4) {
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    if (strlen(argv[2]) >= sizeof(addr.sun_path)) return 64;
    strcpy(addr.sun_path, argv[2]);
    int server = socket(AF_UNIX, SOCK_STREAM, 0);
    if (server < 0 || bind(server, (struct sockaddr *)&addr, sizeof(addr))
        || chmod(argv[2], 0600) || listen(server, 1)) {
      perror("listen"); return 1;
    }
    puts("LISTENING"); fflush(stdout);
    int client = accept(server, NULL, NULL);
    uid_t uid; gid_t gid;
    if (client < 0 || getpeereid(client, &uid, &gid)) { perror("getpeereid"); return 1; }
    char untrusted[128];
    if (read(client, untrusted, sizeof(untrusted)) < 1) return 1;
    /* The payload is deliberately never parsed as an identity. */
    int allowed = uid == (uid_t)strtoul(argv[3], NULL, 10);
    printf("PEER %u %u %s\n", (unsigned)uid, (unsigned)gid, allowed ? "ALLOW" : "DENY");
    fflush(stdout);
    close(client); close(server);
    return allowed ? 0 : 77;
  }
  if (strcmp(argv[1], "listen") == 0 && argc == 3) {
    /* Stale-socket experiment: plain bind (no pre-unlink); caller must show that a
     * leftover socket blocks rebind and that cleanup belongs to the lock holder. */
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    if (strlen(argv[2]) >= sizeof(addr.sun_path)) return 64;
    strcpy(addr.sun_path, argv[2]);
    int server = socket(AF_UNIX, SOCK_STREAM, 0);
    if (server < 0 || bind(server, (struct sockaddr *)&addr, sizeof(addr))
        || chmod(argv[2], 0600) || listen(server, 1)) {
      perror("bind"); return 1;
    }
    puts("LISTENING"); fflush(stdout);
    (void)getchar(); /* clean release removes the endpoint; SIGKILL leaves it stale */
    unlink(argv[2]);
    close(server);
    return 0;
  }
  return 64;
}
